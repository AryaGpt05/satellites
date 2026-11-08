/**
 * Geometry conventions shared by engine + globe. DO NOT change conventions without updating both.
 *
 * WORLD FRAME (three.js scene):
 *   - Earth is a unit sphere centred at origin, radius 1 world unit = EARTH_RADIUS_KM.
 *   - The Earth mesh is FIXED (Earth-fixed / ECEF frame). We never rotate the Earth mesh;
 *     instead the sun direction and inertial objects (stars) rotate with GMST.
 *   - +Y = north pole. lat 0 / lon 0 → +X. lon +90°E → -Z.  (matches three.js SphereGeometry UVs
 *     with an equirectangular texture whose left edge is lon -180°.)
 *
 *   ECEF (x, y, z) km  →  world (x, z, -y) / R
 */
import { Vector3 } from 'three'

export const EARTH_RADIUS_KM = 6371.0
/** WGS-84 equatorial radius used by SGP4 */
export const EARTH_EQ_RADIUS_KM = 6378.137
export const MU_KM3_S2 = 398600.4418
export const J2 = 1.08262668e-3
export const DEG = Math.PI / 180
export const RAD = 180 / Math.PI
export const MS_PER_DAY = 86_400_000

export function latLonToWorld(latDeg: number, lonDeg: number, radius = 1, out = new Vector3()): Vector3 {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  const c = Math.cos(lat)
  return out.set(radius * c * Math.cos(lon), radius * Math.sin(lat), -radius * c * Math.sin(lon))
}

export function worldToLatLon(v: Vector3): { lat: number; lon: number } {
  const r = v.length()
  return { lat: Math.asin(v.y / r) * RAD, lon: Math.atan2(-v.z, v.x) * RAD }
}

/** ECEF km → world units */
export function ecefToWorld(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x / EARTH_RADIUS_KM, z / EARTH_RADIUS_KM, -y / EARTH_RADIUS_KM)
}

/** Julian date from epoch ms */
export function julianDate(ms: number): number {
  return ms / MS_PER_DAY + 2440587.5
}

/** Greenwich Mean Sidereal Time in radians (IAU 1982), adequate for visualisation + pass geometry. */
export function gmst(ms: number): number {
  const jd = julianDate(ms)
  const t = (jd - 2451545.0) / 36525
  let g =
    -6.2e-6 * t * t * t + 0.093104 * t * t + (876600 * 3600 + 8640184.812866) * t + 67310.54841 // seconds
  g = ((g * DEG) / 240) % (2 * Math.PI)
  return g < 0 ? g + 2 * Math.PI : g
}

/** Rotate an ECI (TEME-ish) vector into ECEF by GMST. */
export function eciToEcef(x: number, y: number, z: number, ms: number): [number, number, number] {
  const g = gmst(ms)
  const c = Math.cos(g)
  const s = Math.sin(g)
  return [c * x + s * y, -s * x + c * y, z]
}

/**
 * Unit vector from Earth centre to the Sun in ECI (low precision, ~0.01°), per the Astronomical Almanac.
 */
export function sunEci(ms: number): [number, number, number] {
  const n = julianDate(ms) - 2451545.0
  const L = (280.46 + 0.9856474 * n) % 360
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG
  const eps = (23.439 - 0.0000004 * n) * DEG
  return [Math.cos(lambda), Math.cos(eps) * Math.sin(lambda), Math.sin(eps) * Math.sin(lambda)]
}

/** Unit vector toward the Sun in the WORLD frame (Earth-fixed). Feed this to the globe shader. */
export function sunDirectionWorld(ms: number, out = new Vector3()): Vector3 {
  const [x, y, z] = sunEci(ms)
  const [ex, ey, ez] = eciToEcef(x, y, z, ms)
  return out.set(ex, ez, -ey).normalize()
}

/** Sub-solar point */
export function subsolarPoint(ms: number): { lat: number; lon: number } {
  return worldToLatLon(sunDirectionWorld(ms))
}

/** Sun elevation (degrees) at a place — positive = above horizon. */
export function sunElevationDeg(lat: number, lon: number, ms: number): number {
  const s = sunDirectionWorld(ms)
  const p = latLonToWorld(lat, lon)
  return Math.asin(Math.max(-1, Math.min(1, s.dot(p)))) * RAD
}

/** Great-circle distance in km (haversine) */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * DEG
  const dLon = (b.lon - a.lon) * DEG
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** Initial bearing from a to b, degrees from north */
export function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const φ1 = a.lat * DEG
  const φ2 = b.lat * DEG
  const Δλ = (b.lon - a.lon) * DEG
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * RAD + 360) % 360
}

/** Square bbox (lon/lat) of half-size km around a point: [minLon, minLat, maxLon, maxLat] */
export function bboxAround(lat: number, lon: number, halfKm: number): [number, number, number, number] {
  const dLat = (halfKm / EARTH_RADIUS_KM) * RAD
  const dLon = dLat / Math.max(0.01, Math.cos(lat * DEG))
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
}

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
