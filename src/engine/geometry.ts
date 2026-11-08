/**
 * Spherical-Earth viewing geometry (R = EARTH_RADIUS_KM, as in src/lib/geo.ts).
 *
 * In the plane containing Earth's centre O, the ground point P and the satellite S at radius r = R + h,
 * with central angle γ = groundDistance / R:
 *
 *   off-nadir  η = atan2(R sin γ, r − R cos γ)        (angle at S between nadir and P)
 *   elevation  ε = atan2(r cos γ − R, r sin γ)        (angle at P above the local horizontal)
 *   and always  η + ε + γ = 90°.
 *
 * Inverses (ground range reached at a given angle):
 *   at off-nadir η:     γ = asin((r/R) sin η) − η     (clamped to the horizon, γ_h = acos(R/r))
 *   at elevation ε:     γ = acos((R/r) cos ε) − ε
 */
import { DEG, EARTH_RADIUS_KM, eciToEcef, RAD, sunEci } from '@/lib/geo'

const R = EARTH_RADIUS_KM

export function offNadirDeg(groundKm: number, altKm: number): number {
  const g = groundKm / R
  const r = R + altKm
  return Math.atan2(R * Math.sin(g), r - R * Math.cos(g)) * RAD
}

export function elevationDeg(groundKm: number, altKm: number): number {
  const g = groundKm / R
  const r = R + altKm
  return Math.atan2(r * Math.cos(g) - R, r * Math.sin(g)) * RAD
}

/** Ground range (km) from the sub-satellite point to where the line of sight at `offNadir` meets the surface. */
export function groundRangeAtOffNadirKm(offNadir: number, altKm: number): number {
  const r = R + altKm
  const s = (r / R) * Math.sin(offNadir * DEG)
  const horizon = Math.acos(R / r)
  if (s >= 1) return horizon * R
  return Math.min(horizon, Math.asin(s) - offNadir * DEG) * R
}

/** Ground range (km) within which the satellite stands at least `minElevation` above the horizon. */
export function groundRangeAtElevationKm(minElevation: number, altKm: number): number {
  const r = R + altKm
  const e = minElevation * DEG
  return (Math.acos((R / r) * Math.cos(e)) - e) * R
}

/**
 * Sun elevation (degrees) at a place: exactly the maths of geo.ts `sunElevationDeg` (its low-precision
 * solar ephemeris, rotated by GMST, against the spherical place vector), but in plain numbers. geo.ts
 * goes through three.js Vector3, which would otherwise be bundled into the pass worker for this one
 * call. Tested equal to geo.ts in geo.test.ts.
 */
export function sunElevationAtDeg(lat: number, lon: number, ms: number): number {
  const [sx, sy, sz] = sunEci(ms)
  const [x, y, z] = eciToEcef(sx, sy, sz, ms)
  const la = lat * DEG
  const lo = lon * DEG
  const c = Math.cos(la)
  const dot = (x * c * Math.cos(lo) + y * c * Math.sin(lo) + z * Math.sin(la)) / Math.hypot(x, y, z)
  return Math.asin(Math.max(-1, Math.min(1, dot))) * RAD
}
