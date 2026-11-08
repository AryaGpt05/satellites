import { describe, expect, it } from 'vitest'
import { DEG, RAD } from '@/lib/geo'
import type { Pass } from '@/types'
import { fovFor, overviewPose, passPose, placePose, rangeForEarthFraction, resultsShift, type Viewport } from './framing'

const desktop: Viewport = { width: 1440, height: 900 }
const phone: Viewport = { width: 390, height: 844 }

describe('fovFor', () => {
  it('is 30° on landscape screens', () => {
    expect(fovFor(desktop)).toBeCloseTo(30, 9)
  })
  it('holds at least 22° horizontally on portrait screens', () => {
    const v = fovFor(phone) * DEG
    const h = 2 * Math.atan(Math.tan(v / 2) * (phone.width / phone.height))
    expect(h * RAD).toBeCloseTo(22, 6)
    expect(fovFor(phone)).toBeGreaterThan(30)
  })
})

describe('rangeForEarthFraction', () => {
  for (const vp of [desktop, phone]) {
    it(`makes the Earth span the requested fraction (${vp.width}×${vp.height})`, () => {
      const r = rangeForEarthFraction(vp, 0.74)
      const D = 1 + r
      const rho = Math.asin(1 / D)
      const tanHalf = Math.tan((fovFor(vp) * DEG) / 2) * Math.min(1, vp.width / vp.height)
      expect(Math.tan(rho) / tanHalf).toBeCloseTo(0.74, 9)
    })
  }
})

describe('composition', () => {
  it('puts the overview globe right of centre on desktop and centres it on phones', () => {
    expect(overviewPose(desktop, 20, 0).shiftX).toBeGreaterThan(0.15)
    expect(overviewPose(phone, 20, 0).shiftX).toBe(0)
    expect(overviewPose(phone, 20, 0).range).toBeGreaterThan(overviewPose(desktop, 20, 0).range)
  })

  it('centres results subjects in the area the right-docked panel leaves free', () => {
    const { shiftX, shiftY } = resultsShift(desktop)
    const subjectX = ((shiftX + 1) / 2) * desktop.width
    expect(subjectX).toBeCloseTo((desktop.width - 464) / 2, 6)
    expect(shiftY).toBe(0)
  })

  it('lifts results subjects above the bottom sheet on phones', () => {
    const { shiftX, shiftY } = resultsShift(phone)
    expect(shiftX).toBe(0)
    expect(shiftY).toBeGreaterThan(0.3)
  })

  it('frames a place at regional altitude', () => {
    const p = placePose(desktop, 43.47, -80.54)
    expect(p.range).toBeGreaterThan(0.45)
    expect(p.range).toBeLessThan(1.6)
  })
})

describe('passPose', () => {
  const pass = (over: Partial<Pass>): Pass => ({
    id: 'x',
    norad: 1,
    tClosest: 1000,
    tStart: 0,
    tEnd: 2000,
    groundDistanceKm: 0,
    offNadirDeg: 0,
    elevationDeg: 90,
    azimuthDeg: 0,
    altitudeKm: 786,
    groundSpeedKmS: 6.9,
    headingDeg: 192,
    node: 'descending',
    sunElevationDeg: 30,
    inSwath: true,
    inFieldOfRegard: true,
    verdict: 'imaged',
    track: [{ t: 1000, lat: 43.47, lon: -80.54, altKm: 786 }],
    ...over,
  })

  it('looks along the ground-track heading at ~35° tilt, above the place', () => {
    const p = passPose(desktop, pass({}), { lat: 43.47, lon: -80.54 })
    expect(p.headingDeg).toBe(192)
    expect(p.tilt! * RAD).toBeCloseTo(35, 9)
    expect(p.lat).toBeCloseTo(43.47, 9)
    expect(p.lon).toBeCloseTo(-80.54, 9)
  })

  it('moves the look-at toward an off-track satellite (pointable imagers)', () => {
    const p = passPose(desktop, pass({ groundDistanceKm: 1500, track: [{ t: 1000, lat: 43.47, lon: -62, altKm: 500 }] }), {
      lat: 43.47,
      lon: -80.54,
    })
    expect(p.lon).toBeGreaterThan(-80.54)
    expect(p.lon).toBeLessThan(-70)
  })

  it('takes the short way across the antimeridian', () => {
    const p = passPose(desktop, pass({ groundDistanceKm: 1500, track: [{ t: 1000, lat: 0, lon: -179, altKm: 500 }] }), {
      lat: 0,
      lon: 179,
    })
    expect(Math.abs(p.lon)).toBeGreaterThan(179)
  })
})
