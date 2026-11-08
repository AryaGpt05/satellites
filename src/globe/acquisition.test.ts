import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { EARTH_RADIUS_KM, latLonToWorld } from '@/lib/geo'
import type { Pass, Report } from '@/types'
import {
  approachStart,
  closestLookPass,
  decalSpecFor,
  fmtCountdown,
  MIN_APPROACH_S,
  PAINT_REAL_S,
  scanAt,
  scanFrame,
  slowFactor,
  slowWindowS,
} from './acquisition'
import { acquiredPose, chasePose, freeRect, rangeForGroundKm } from './framing'

const TC = 1_800_000_000_000

/** Real seconds a replay at `rate` takes from `from` to `to` (sim ms), slow motion included. */
function realSeconds(from: number, to: number, halfKm: number, speed: number, rate: number) {
  let t = from
  let real = 0
  const dt = 1 / 240
  while (t < to) {
    t += rate * slowFactor(t, TC, halfKm, speed, rate) * dt * 1000
    real += dt
  }
  return real
}

describe('acquisition timing', () => {
  it('slows the replay around closest approach so a Sentinel-2 decal paints over ~PAINT_REAL_S', () => {
    expect(slowFactor(TC - 120_000, TC, 40, 6.8, 30)).toBe(1)
    const floor = slowFactor(TC, TC, 40, 6.8, 30)
    expect(floor).toBeGreaterThan(0.15)
    expect(floor).toBeLessThan(0.4)
    const paint = realSeconds(TC - (40 / 6.8) * 1000, TC + (40 / 6.8) * 1000, 40, 6.8, 30)
    expect(paint).toBeGreaterThan(PAINT_REAL_S * 0.85)
    expect(paint).toBeLessThan(PAINT_REAL_S * 1.15)
  })

  it('does not slow a wide daily mosaic (it already paints slowly enough) nor a pass without an image', () => {
    expect(slowFactor(TC, TC, 300, 6.6, 30)).toBe(1)
    expect(slowFactor(TC, TC, 0, 6.8, 30)).toBe(1)
  })

  it('rewinds a short lead so the approach takes at least MIN_APPROACH_S, and keeps a long one', () => {
    const seeded = TC - 36_000 // results: 1.2 s at 30×
    const start = approachStart(seeded, TC, 40, 6.8, 30)
    expect(start).toBeLessThan(seeded)
    expect(realSeconds(start, TC, 40, 6.8, 30)).toBeGreaterThanOrEqual(MIN_APPROACH_S - 0.05)
    expect(TC - start).toBeLessThanOrEqual(88_000)
    expect(approachStart(TC - 300_000, TC, 40, 6.8, 30)).toBe(TC - 300_000)
    expect(approachStart(TC + 1000, TC, 40, 6.8, 30)).toBe(TC + 1000)
  })

  it('the full sequence (2.4–3.6 s flight + approach + 1.4 s settle) lands in 6–8 s at the default rate', () => {
    const approach = realSeconds(approachStart(TC - 36_000, TC, 40, 6.8, 30), TC, 40, 6.8, 30)
    const settle = 0.28 + 1.4
    for (const flight of [2.4, 3.6]) {
      const total = flight + approach + settle
      expect(total).toBeGreaterThanOrEqual(6)
      expect(total).toBeLessThanOrEqual(8)
    }
  })

  it('formats the countdown in sim time', () => {
    expect(fmtCountdown(TC - 72_000, TC)).toBe('T−00:01:12')
    expect(fmtCountdown(TC, TC)).toBe('T+00:00:00')
    expect(fmtCountdown(TC + 3_400, TC)).toBe('T+00:00:03')
  })

  it('the slow-motion window covers the decal', () => {
    expect(slowWindowS(40, 6.8) * 6.8).toBeGreaterThan(40)
  })
})

describe('decal and scan geometry', () => {
  it('crops per collection, smaller on phones, none for geostationary frames', () => {
    expect(decalSpecFor('sentinel-2-l2a', false)).toEqual({ halfSizeKm: 40, px: 1024 })
    expect(decalSpecFor('landsat-c2-l2', true)).toEqual({ halfSizeKm: 45, px: 768 })
    expect(decalSpecFor('gibs-viirs-noaa20', false)?.halfSizeKm).toBe(300)
    expect(decalSpecFor('gibs-goes-east', false)).toBeNull()
  })

  it('the scan frame sits on the track at closest approach and points along the motion', () => {
    // A descending track along lon −80, through lat 44 at TC.
    const track = [-60, -30, 0, 30, 60].map((s) => ({ t: TC + s * 1000, lat: 44 - (s * 6.8) / 111.2, lon: -80, altKm: 786 }))
    const p0 = new Vector3()
    const t0 = new Vector3()
    scanFrame({ track, tClosest: TC }, p0, t0)
    expect(p0.distanceTo(latLonToWorld(44, -80, 1))).toBeLessThan(1e-6)
    expect(Math.abs(t0.dot(p0))).toBeLessThan(1e-9)
    // Moving south: t0 points to lower latitudes.
    expect(t0.dot(latLonToWorld(43, -80, 1).sub(latLonToWorld(44, -80, 1)))).toBeGreaterThan(0)
    // The scan line moves at ground speed.
    expect(scanAt(TC + 10_000, TC, 6.8) * EARTH_RADIUS_KM).toBeCloseTo(68, 6)
  })

  it('picks the most zoomed-in capture first, then the clearest, then the newest', () => {
    const pass = (id: string, t: number, captureId: string): Pass => ({ id, tClosest: t, verdict: 'imaged', captureId }) as unknown as Pass
    const cap = (id: string, collection: string, gsdM: number, spot?: string) => ({ id, collection, gsdM, spot })
    const report = {
      partial: false,
      passes: [pass('a', 1, 'ca'), pass('b', 2, 'cb'), pass('c', 3, 'cc'), pass('d', 4, 'cd')],
      captures: [cap('ca', 'landsat-c2-l2', 30, 'clear'), cap('cb', 'sentinel-2-l2a', 10, 'cloud'), cap('cc', 'sentinel-2-l2a', 10, 'clear'), cap('cd', 'gibs-viirs-noaa20', 375, 'clear')],
    } as unknown as Report
    expect(closestLookPass(report)?.id).toBe('c')
  })
})

describe('acquisition camera poses', () => {
  const vp = { width: 1440, height: 900 }
  const insets = { top: 80, right: 480, bottom: 220, left: 0 }

  it('the acquired view is near top-down, north-up and frames the image at a fixed share of the free rect', () => {
    const spec = acquiredPose(vp, insets, { lat: 43.47, lon: -80.54 }, 40)
    expect(spec.headingDeg).toBe(0)
    expect(spec.tilt!).toBeLessThan(0.1)
    const fill = rangeForGroundKm(vp, freeRect(vp, insets), 80) / spec.range
    expect(fill).toBeGreaterThan(0.45)
    expect(fill).toBeLessThan(0.55)
  })

  it('the chase looks at the midpoint between the place and the spacecraft, oblique and north-up', () => {
    const sat = latLonToWorld(46, -81, 1 + 786 / EARTH_RADIUS_KM)
    const spec = chasePose(vp, insets, sat, { lat: 43.47, lon: -80.54 })
    expect(spec.headingDeg).toBe(0)
    expect(spec.tilt!).toBeGreaterThan(0.7)
    expect(spec.r!).toBeGreaterThan(1)
    expect(spec.lat).toBeGreaterThan(43.47)
    expect(spec.lat).toBeLessThan(46)
  })
})
