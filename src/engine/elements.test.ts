import { beforeAll, describe, expect, it } from 'vitest'
import { EARTH_RADIUS_KM, ecefToWorld } from '@/lib/geo'
import { CATEGORY_INDEX } from './categories'
import { satrecFor, type LoadedCatalog } from './catalog'
import { buildElementBuffer, ELEMENT_STRIDE, keplerJ2World, type ElementBuffer } from './elements'
import { stateAt } from './propagate'
import { loadTestCatalog } from './testing'

let cat: LoadedCatalog
let buf: ElementBuffer
beforeAll(() => {
  cat = loadTestCatalog()
  buf = buildElementBuffer(cat)
})

/** Max position error (km) of the shader math vs SGP4 over [ref − 24 h, ref + 24 h], 10-minute steps. */
function maxErrorKm(norad: number): number {
  const index = Array.from(buf.norad).indexOf(norad)
  expect(index).toBeGreaterThanOrEqual(0)
  const satrec = satrecFor(norad)!
  let worst = 0
  const w = { x: 0, y: 0, z: 0 }
  for (let dt = -86_400_000; dt <= 86_400_000; dt += 600_000) {
    const ms = buf.refEpochMs + dt
    const s = stateAt(satrec, ms)!
    const ref = ecefToWorld(...s.ecef)
    keplerJ2World(buf, index, ms, w)
    const err = Math.hypot(w.x - ref.x, w.y - ref.y, w.z - ref.z) * EARTH_RADIUS_KM
    worst = Math.max(worst, err)
  }
  return worst
}

describe('buildElementBuffer', () => {
  it('packs every catalog object with stride 12', () => {
    expect(buf.count).toBe(cat.sats.length)
    expect(buf.data.length).toBe(buf.count * ELEMENT_STRIDE)
    expect(buf.norad.length).toBe(buf.count)
    expect(buf.refEpochMs).toBe(Date.parse(cat.fetchedAt))
    const iss = Array.from(buf.norad).indexOf(25544)
    const o = iss * ELEMENT_STRIDE
    expect(buf.data[o]).toBeGreaterThan(1.05) // ~420 km altitude
    expect(buf.data[o]).toBeLessThan(1.08)
    expect(buf.data[o + 10]).toBe(CATEGORY_INDEX.crewed)
    expect(buf.data[o + 11]).toBe(1)
    // ISS node regresses ~5°/day
    const raanDotDegDay = (buf.data[o + 7] * 86_400 * 180) / Math.PI
    expect(raanDotDegDay).toBeGreaterThan(-5.3)
    expect(raanDotDegDay).toBeLessThan(-4.7)
  })

  const LEO: [string, number][] = [
    ['ISS', 25544],
    ['Sentinel-2A', 40697],
    ['NOAA-20', 43013],
    ['Landsat 9', 49260],
    ['ICEYE-X2', 43800],
    ['Tiangong', 48274],
  ]
  for (const [name, norad] of LEO) {
    it(`${name}: shader math within 80 km of SGP4 over ±24 h`, () => {
      const err = maxErrorKm(norad)
      console.log(`${name}: max error ${err.toFixed(1)} km`)
      expect(err).toBeLessThan(80)
    })
  }

  const GEO: [string, number][] = [
    ['GOES-19', 60133],
    ['Himawari-9', 41836],
    ['Meteosat-12', 54743],
  ]
  for (const [name, norad] of GEO) {
    it(`${name}: shader math within 200 km of SGP4 over ±24 h`, () => {
      const err = maxErrorKm(norad)
      console.log(`${name}: max error ${err.toFixed(1)} km`)
      expect(err).toBeLessThan(200)
    })
  }
})

describe('element buffer accuracy across the catalog', () => {
  it('logs the error distribution at ±12 h and ±24 h (LEO and GEO)', () => {
    const leo: number[] = []
    const geo: number[] = []
    const w = { x: 0, y: 0, z: 0 }
    for (let k = 0; k < buf.count; k += 7) {
      const norad = buf.norad[k]
      const satrec = satrecFor(norad)
      if (!satrec) continue
      const revsPerDay = (buf.data[k * ELEMENT_STRIDE + 6] * 86_400) / (2 * Math.PI)
      let worst = 0
      for (const dt of [-86_400_000, -43_200_000, 43_200_000, 86_400_000]) {
        const ms = buf.refEpochMs + dt
        const s = stateAt(satrec, ms)
        if (!s) {
          worst = Number.NaN
          break
        }
        const ref = ecefToWorld(...s.ecef)
        keplerJ2World(buf, k, ms, w)
        worst = Math.max(worst, Math.hypot(w.x - ref.x, w.y - ref.y, w.z - ref.z) * EARTH_RADIUS_KM)
      }
      if (!Number.isFinite(worst)) continue
      if (revsPerDay > 11) leo.push(worst)
      else if (revsPerDay > 0.9 && revsPerDay < 1.1) geo.push(worst)
    }
    const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]
    console.log(
      `LEO n=${leo.length}: p50 ${q(leo, 0.5).toFixed(1)} km, p95 ${q(leo, 0.95).toFixed(1)} km, p99 ${q(leo, 0.99).toFixed(1)} km; ` +
        `GEO n=${geo.length}: p50 ${q(geo, 0.5).toFixed(1)} km, p95 ${q(geo, 0.95).toFixed(1)} km`,
    )
    expect(q(leo, 0.5)).toBeLessThan(80)
    expect(q(geo, 0.95)).toBeLessThan(200)
  })
})
