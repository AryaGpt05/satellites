/**
 * The Vector3 helpers of src/lib/geo.ts (world-frame conventions in its header). A module of their own, with
 * three's math classes, so that the first bundle (the HUD and the boot log only need scalar sun geometry)
 * never carries Vector3/Quaternion: vite.config.ts declares this module side-effect free.
 */
// The math module only (Vector3 + Quaternion + MathUtils, ~4 kB gz), not the 'three' barrel, which would pull
// all of three.js. Same class shape and `isVector3` flag, so three's API takes these vectors as is.
import { Vector3 } from 'three/src/math/Vector3.js'
import { DEG, EARTH_RADIUS_KM, RAD, sunEcefUnit } from './geoCore'

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

/** Unit vector toward the Sun in the WORLD frame (Earth-fixed). Feed this to the globe shader. */
export function sunDirectionWorld(ms: number, out = new Vector3()): Vector3 {
  const [ex, ey, ez] = sunEcefUnit(ms)
  return out.set(ex, ez, -ey)
}
