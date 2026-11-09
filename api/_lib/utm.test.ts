import { describe, expect, it } from 'vitest'
import { centralMeridianDeg, gridBearingDeg, gridBearingOfNorthDeg, isUtmEpsg, utmForward, utmInverse, utmScaleFactor, utmZoneOf } from './utm'

/**
 * An independent reference: Snyder's transverse Mercator series in e² (USGS Professional Paper 1395, eqs. 8-9 to
 * 8-10), good to a few millimetres within ~4° of the central meridian. Different method, different expansion: if
 * both agree there, neither has a typo.
 */
function snyderForward(zone: number, south: boolean, lat: number, lon: number): [number, number] {
  const a = 6378137
  const f = 1 / 298.257223563
  const k0 = 0.9996
  const e2 = f * (2 - f)
  const ep2 = e2 / (1 - e2)
  const phi = (lat * Math.PI) / 180
  const lam = ((lon - centralMeridianDeg(zone)) * Math.PI) / 180
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2)
  const T = Math.tan(phi) ** 2
  const C = ep2 * Math.cos(phi) ** 2
  const A = lam * Math.cos(phi)
  const e4 = e2 * e2
  const e6 = e4 * e2
  const M =
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi))
  const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120)
  const y =
    k0 *
    (M +
      N *
        Math.tan(phi) *
        ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720))
  return [500000 + x, (south ? 10_000_000 : 0) + y]
}

/** A deterministic pseudo-random sequence (tests must not flake). */
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

describe('utm zones', () => {
  it('reads EPSG:326zz / 327zz and nothing else', () => {
    expect(utmZoneOf(32633)).toEqual({ zone: 33, south: false })
    expect(utmZoneOf(32756)).toEqual({ zone: 56, south: true })
    expect(utmZoneOf(32601)).toEqual({ zone: 1, south: false })
    expect(utmZoneOf(32760)).toEqual({ zone: 60, south: true })
    for (const bad of [4326, 3031, 3413, 32600, 32661, 32700, 32761, 3857, 32633.5]) expect(utmZoneOf(bad)).toBeNull()
    expect(isUtmEpsg(32617)).toBe(true)
    expect(centralMeridianDeg(33)).toBe(15)
    expect(centralMeridianDeg(1)).toBe(-177)
  })
  it('refuses to project on a CRS it does not know', () => {
    expect(() => utmForward(3031, -80, 0)).toThrow()
    expect(() => utmInverse(4326, 0, 0)).toThrow()
  })
})

describe('utmForward', () => {
  it('matches GeographicLib’s published example (Baghdad: 33.3 N 44.4 E → 38n 444140.54 3684706.36)', () => {
    const [x, y] = utmForward(32638, 33.3, 44.4)
    expect(x).toBeCloseTo(444140.54, 2)
    expect(y).toBeCloseTo(3684706.36, 2)
  })
  it('puts the central meridian on 500 000 m and the equator on 0 / 10 000 000 m', () => {
    expect(utmForward(32633, 0, 15)).toEqual([500000, 0])
    const [x, y] = utmForward(32733, 0, 15)
    expect(x).toBe(500000)
    expect(y).toBe(10_000_000)
  })
  it('agrees with Snyder’s independent series to < 5 mm within 3.5° of the central meridian', () => {
    const r = rng(7)
    let worst = 0
    for (let i = 0; i < 4000; i++) {
      const zone = 1 + Math.floor(r() * 60)
      const lat = -80 + r() * 164
      const lon = centralMeridianDeg(zone) + (r() * 2 - 1) * 3.5
      const south = lat < 0
      const [x, y] = utmForward(south ? 32700 + zone : 32600 + zone, lat, lon)
      const [sx, sy] = snyderForward(zone, south, lat, lon)
      worst = Math.max(worst, Math.hypot(x - sx, y - sy))
    }
    expect(worst).toBeLessThan(0.005)
  })
  it('gives Landsat’s negative northings south of the equator on a north zone (EPSG:32656 at Sydney)', () => {
    const [x, y] = utmForward(32656, -33.8688, 151.2093)
    const [xs, ys] = utmForward(32756, -33.8688, 151.2093)
    expect(x).toBeCloseTo(xs, 6)
    expect(y).toBeCloseTo(ys - 10_000_000, 6)
    expect(y).toBeLessThan(0)
  })
})

describe('utmInverse', () => {
  it('inverts the forward to well under a millimetre anywhere a scene can be (±9° from the meridian, ±84°)', () => {
    const r = rng(11)
    let worstM = 0
    for (let i = 0; i < 4000; i++) {
      const zone = 1 + Math.floor(r() * 60)
      const epsg = (r() < 0.5 ? 32600 : 32700) + zone
      const lat = -84 + r() * 168
      const lon = centralMeridianDeg(zone) + (r() * 2 - 1) * 9
      const [x, y] = utmForward(epsg, lat, lon)
      const [lat2, lon2] = utmInverse(epsg, x, y)
      const [x2, y2] = utmForward(epsg, lat2, lon2)
      worstM = Math.max(worstM, Math.hypot(x2 - x, y2 - y))
      expect(lat2).toBeCloseTo(lat, 9)
      expect(((lon2 - lon + 540) % 360) - 180).toBeCloseTo(0, 9)
    }
    expect(worstM).toBeLessThan(1e-4)
  })
  it('wraps longitudes across the antimeridian (zone 60, zone 1)', () => {
    const [x, y] = utmForward(32601, 10, 179.5) // 2.5° west of zone 1's meridian, across ±180
    const [lat, lon] = utmInverse(32601, x, y)
    expect(lat).toBeCloseTo(10, 9)
    expect(lon).toBeCloseTo(179.5, 9)
  })
})

describe('meridian convergence and scale', () => {
  it('is (λ − λ0)·sin φ with the sign that turns a compass bearing into a grid bearing', () => {
    // Berlin (west of zone 33's 15° E meridian): moving north drifts east on the grid → grid north is left of true north.
    const berlin = gridBearingOfNorthDeg(32633, 52.52, 13.405)
    expect(berlin).toBeGreaterThan(0)
    expect(berlin).toBeCloseTo(Math.atan(Math.tan((1.595 * Math.PI) / 180) * Math.sin((52.52 * Math.PI) / 180)) * (180 / Math.PI), 2)
    // East of the meridian in the north: negative. South of the equator: the sign flips.
    expect(gridBearingOfNorthDeg(32633, 59.33, 17.9)).toBeCloseTo(-2.49, 1)
    expect(gridBearingOfNorthDeg(32756, -33.8688, 151.2093)).toBeCloseTo(-1.0, 1)
    expect(gridBearingOfNorthDeg(32633, 50, 15)).toBeCloseTo(0, 9)
    expect(gridBearingDeg(32633, 52.52, 13.405, 0)).toBeCloseTo(berlin, 9)
    expect(gridBearingDeg(32633, 59.33, 17.9, 1)).toBeCloseTo(358.51, 1)
  })
  it('stays under 3° in a standard 6° zone, but reaches 5.4° in Norway’s zone 32 and 6° in Svalbard’s 12° zones', () => {
    expect(Math.abs(gridBearingOfNorthDeg(32602, 83.9, -174))).toBeLessThan(3) // 3° off zone 2's meridian, 84° N
    expect(gridBearingOfNorthDeg(32632, 63.99, 3)).toBeCloseTo(5.39, 1) // Norway: zone 32 runs 3°–12° E about 9° E
    expect(gridBearingOfNorthDeg(32633, 83.9, 9)).toBeCloseTo(5.97, 1) // Svalbard: zone 33 runs 9°–21° E about 15° E
  })
  it('agrees with the projection itself: the grid direction of a short step due north', () => {
    const [x0, y0] = utmForward(32627, 64.1466, -21.9426)
    const [x1, y1] = utmForward(32627, 64.1566, -21.9426)
    expect((Math.atan2(x1 - x0, y1 - y0) * 180) / Math.PI).toBeCloseTo(gridBearingOfNorthDeg(32627, 64.1466, -21.9426), 3)
  })
  it('scales by k0 = 0.9996 on the central meridian and ~1.001 at a zone edge', () => {
    expect(utmScaleFactor(32633, 45, 15)).toBeCloseTo(0.9996, 6)
    const edge = utmScaleFactor(32633, 0, 18)
    expect(edge).toBeGreaterThan(1.0009)
    expect(edge).toBeLessThan(1.0011)
  })
})
