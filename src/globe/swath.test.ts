import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { DEG, EARTH_RADIUS_KM, haversineKm, latLonToWorld, worldToLatLon } from '@/lib/geo'
import type { SatInfo, TrackPoint } from '@/types'
import { buildRibbon, densifyTrack, fieldModelFor, groundRangeAtOffNadirKm, sweptAcross, trackPointAt } from './swath'

/** A straight southbound track along lon −80.5°, 20 s steps, ~7 km/s ground speed (≈ 0.063° per s). */
function southbound(n = 49, t0 = 1_000_000): TrackPoint[] {
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i * 20_000, lat: 70 - i * 1.26, lon: -80.5, altKm: 786 }))
}

describe('densifyTrack', () => {
  it('keeps endpoints and never steps more than the limit', () => {
    const tr = southbound(5)
    const d = densifyTrack(tr, 0.25)
    expect(d[0]).toMatchObject({ lat: tr[0].lat, lon: tr[0].lon })
    expect(d[d.length - 1]).toMatchObject({ lat: tr[4].lat, lon: tr[4].lon })
    for (let i = 1; i < d.length; i++) expect(haversineKm(d[i - 1], d[i])).toBeLessThan(0.2501 * DEG * EARTH_RADIUS_KM)
  })

  it('crosses the antimeridian along the short way', () => {
    const tr: TrackPoint[] = [
      { t: 0, lat: 10, lon: 179, altKm: 700 },
      { t: 20_000, lat: 11, lon: -179, altKm: 700 },
    ]
    const d = densifyTrack(tr, 0.5)
    for (const p of d) expect(Math.abs(p.lon)).toBeGreaterThan(178.9)
  })
})

describe('buildRibbon', () => {
  const track = southbound()
  const tRef = track[24].t
  const r = buildRibbon(track, tRef, () => 145, { lift: 1 })

  it('puts the edges at the swath half-width, perpendicular to the heading', () => {
    const vpr = r.cols + 1
    const mid = Math.floor(r.rows / 2)
    const p = (k: number) => new Vector3(r.positions[k * 3], r.positions[k * 3 + 1], r.positions[k * 3 + 2])
    const centre = worldToLatLon(p(mid * vpr + r.cols / 2))
    const left = worldToLatLon(p(mid * vpr))
    const right = worldToLatLon(p(mid * vpr + r.cols))
    expect(haversineKm(centre, left)).toBeCloseTo(145, 0)
    expect(haversineKm(centre, right)).toBeCloseTo(145, 0)
    // Southbound: left of the motion is east, right is west; both on the centre's parallel (to first order).
    expect(left.lon).toBeGreaterThan(centre.lon)
    expect(right.lon).toBeLessThan(centre.lon)
    expect(Math.abs(left.lat - centre.lat)).toBeLessThan(0.05)
  })

  it('winds every triangle counter-clockwise seen from outside (front faces render)', () => {
    const a = new Vector3()
    const b = new Vector3()
    const c = new Vector3()
    const n = new Vector3()
    for (let t = 0; t < r.index.length; t += 3) {
      a.fromArray(r.positions, r.index[t] * 3)
      b.fromArray(r.positions, r.index[t + 1] * 3)
      c.fromArray(r.positions, r.index[t + 2] * 3)
      n.subVectors(b, a).cross(c.clone().sub(a))
      expect(n.dot(a)).toBeGreaterThan(0)
    }
  })

  it('carries time relative to tRef and side in [−1, 1]', () => {
    expect(Math.min(...r.along)).toBeCloseTo(-480, 6)
    expect(Math.max(...r.along)).toBeCloseTo(480, 6)
    expect(Math.min(...r.side)).toBe(-1)
    expect(Math.max(...r.side)).toBe(1)
    expect(r.halfWidthKm).toBe(145)
  })
})

describe('field model', () => {
  const sat = (category: SatInfo['category'], profile: Partial<NonNullable<SatInfo['profile']>>): SatInfo => ({
    norad: 1,
    name: 'X',
    displayName: 'X',
    category,
    profile: { operator: 'x', category, blurb: '', ...profile },
  })

  it('uses the fixed swath for pushbroom imagers', () => {
    const m = fieldModelFor(sat('open-optical', { swathKm: 290 }))
    expect(m.mode).toBe('swath')
    expect(m.halfWidthKm(786)).toBe(145)
  })

  it('uses the field of regard for agile imagers', () => {
    const m = fieldModelFor(sat('commercial-optical', { maxOffNadirDeg: 30, swathKm: 13 }))
    expect(m.mode).toBe('regard')
    expect(m.halfWidthKm(500)).toBeCloseTo(groundRangeAtOffNadirKm(30, 500), 9)
    // 30° off nadir from 500 km is a little under 300 km of ground range.
    expect(m.halfWidthKm(500)).toBeGreaterThan(280)
    expect(m.halfWidthKm(500)).toBeLessThan(300)
  })

  it('draws no ribbon for crewed stations', () => {
    expect(fieldModelFor(sat('crewed', {})).mode).toBe('none')
  })
})

describe('sweptAcross', () => {
  const t = 1_000_000
  it('fires once when playback crosses the closest approach', () => {
    expect(sweptAcross(t - 500, t + 500, t)).toBe(true)
    expect(sweptAcross(t - 500, t, t)).toBe(true)
    expect(sweptAcross(t, t + 500, t)).toBe(false) // already past on the previous frame
  })
  it('ignores pauses, rewinds and seeks', () => {
    expect(sweptAcross(t - 500, t - 500, t)).toBe(false)
    expect(sweptAcross(t + 500, t - 500, t)).toBe(false)
    expect(sweptAcross(t - 3_600_000, t + 1, t)).toBe(false)
  })
})

describe('trackPointAt', () => {
  it('interpolates along the great circle and returns null outside the track', () => {
    const tr = southbound(3)
    const mid = trackPointAt(tr, tr[0].t + 10_000)!
    expect(mid.lat).toBeCloseTo((tr[0].lat + tr[1].lat) / 2, 2)
    expect(trackPointAt(tr, tr[0].t - 1)).toBeNull()
    const w = latLonToWorld(mid.lat, mid.lon)
    expect(w.length()).toBeCloseTo(1, 12)
  })
})
