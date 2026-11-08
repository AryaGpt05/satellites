import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { latLonToWorld, RAD, subsolarPoint, sunDirectionWorld, sunElevationDeg, worldToLatLon } from './geo'

// subsolarPoint / sunElevationDeg are scalar (no three.js on the shell's path): they must agree with the
// vector forms the globe uses.
describe('sun geometry', () => {
  const times = [Date.UTC(2026, 10, 8, 3, 31), Date.UTC(2026, 5, 21, 12), Date.UTC(2025, 11, 21, 18, 45), Date.UTC(2027, 2, 20, 0, 5)]
  it('subsolarPoint matches the world-frame sun direction', () => {
    for (const t of times) {
      const v = worldToLatLon(sunDirectionWorld(t))
      const s = subsolarPoint(t)
      expect(s.lat).toBeCloseTo(v.lat, 9)
      expect(s.lon).toBeCloseTo(v.lon, 9)
    }
  })
  it('sunElevationDeg matches the dot product of world vectors', () => {
    for (const t of times)
      for (const [lat, lon] of [[43.47, -80.54], [-33.9, 151.2], [0, 0], [78.2, 15.6]]) {
        const dot = sunDirectionWorld(t, new Vector3()).dot(latLonToWorld(lat, lon))
        expect(sunElevationDeg(lat, lon, t)).toBeCloseTo(Math.asin(dot) * RAD, 9)
      }
  })
  it('the sun is overhead at the sub-solar point', () => {
    const t = times[0]
    const s = subsolarPoint(t)
    expect(sunElevationDeg(s.lat, s.lon, t)).toBeCloseTo(90, 6)
  })
})
