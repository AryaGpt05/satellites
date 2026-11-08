/** Sanity checks of the shared frame conventions (src/lib/geo.ts) that the engine relies on. */
import { gstime } from 'satellite.js'
import { describe, expect, it } from 'vitest'
import { gmst, julianDate, subsolarPoint, sunElevationDeg } from '@/lib/geo'
import { elevationDeg, groundRangeAtElevationKm, groundRangeAtOffNadirKm, offNadirDeg, sunElevationAtDeg } from './geometry'

describe('geo.ts gmst', () => {
  it('matches satellite.js gstime to < 1e-6 rad across decades', () => {
    let worst = 0
    for (let ms = Date.UTC(2000, 0, 1); ms < Date.UTC(2040, 0, 1); ms += 37.3 * 86_400_000) {
      const a = gmst(ms)
      const b = gstime(julianDate(ms))
      const d = Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
      worst = Math.max(worst, d)
    }
    expect(worst).toBeLessThan(1e-6)
  })
})

describe('geo.ts sun', () => {
  it('puts the sub-solar point on the tropics at the solstices and the equator at the equinox', () => {
    expect(subsolarPoint(Date.UTC(2026, 5, 21, 12)).lat).toBeCloseTo(23.44, 0)
    expect(subsolarPoint(Date.UTC(2026, 11, 21, 12)).lat).toBeCloseTo(-23.44, 0)
    expect(Math.abs(subsolarPoint(Date.UTC(2026, 2, 20, 12)).lat)).toBeLessThan(0.5)
  })

  it('engine sunElevationAtDeg (no three.js) equals geo.ts sunElevationDeg', () => {
    let worst = 0
    for (let k = 0; k < 2000; k++) {
      const lat = -90 + ((k * 37) % 181)
      const lon = -180 + ((k * 97) % 361)
      const ms = Date.UTC(2026, 0, 1) + k * 15_731_000
      worst = Math.max(worst, Math.abs(sunElevationAtDeg(lat, lon, ms) - sunElevationDeg(lat, lon, ms)))
    }
    expect(worst).toBeLessThan(1e-9)
  })

  it('has the sun high at local noon and below the horizon at local midnight', () => {
    // Greenwich, June solstice: noon elevation ≈ 90 − 51.48 + 23.44 = 61.96°
    expect(sunElevationDeg(51.48, 0, Date.UTC(2026, 5, 21, 12, 2))).toBeCloseTo(61.96, 0)
    expect(sunElevationDeg(51.48, 0, Date.UTC(2026, 5, 21, 0, 2))).toBeLessThan(-10)
    // Waterloo, 8 Nov: noon (≈ 16:55 UTC) elevation ≈ 90 − 43.47 − 16.4 ≈ 30°
    expect(sunElevationDeg(43.4723, -80.5449, Date.UTC(2026, 10, 8, 16, 55))).toBeCloseTo(30.1, 0)
  })
})

describe('spherical viewing geometry', () => {
  it('is self-consistent (η + ε + γ = 90°) and invertible', () => {
    for (const alt of [420, 786, 35_786]) {
      for (const d of [0, 50, 300, 900, 1500]) {
        const eta = offNadirDeg(d, alt)
        const el = elevationDeg(d, alt)
        expect(eta + el + (d / 6371) * (180 / Math.PI)).toBeCloseTo(90, 9)
        if (el > 0) {
          expect(groundRangeAtOffNadirKm(eta, alt)).toBeCloseTo(d, 6)
          expect(groundRangeAtElevationKm(el, alt)).toBeCloseTo(d, 6)
        }
      }
    }
  })

  it('gives the expected Sentinel-1 far range and ISS 10° horizon', () => {
    expect(groundRangeAtOffNadirKm(40, 693)).toBeGreaterThan(590)
    expect(groundRangeAtOffNadirKm(40, 693)).toBeLessThan(620)
    expect(groundRangeAtElevationKm(10, 420)).toBeGreaterThan(1350)
    expect(groundRangeAtElevationKm(10, 420)).toBeLessThan(1450)
  })
})
