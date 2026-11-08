/**
 * SGP4 wrappers (satellite.js 7) in the conventions of src/lib/geo.ts.
 *
 *  - Inertial frame: TEME, as output by SGP4.
 *  - Earth-fixed: TEME rotated by GMST (geo.ts `gmst`, identical to satellite.js `gstime`), i.e. the
 *    same pseudo-ECEF the globe uses (`ecefToWorld`).
 *  - lat / lon / altKm are WGS-84 geodetic, which is what maps and geocoders use. When drawing a
 *    satellite next to its ground track, place it with `latLonToWorld(lat, lon, 1 + altKm / R)` so that
 *    it sits exactly above its own track; `ecef` is the true Earth-fixed position (geocentric).
 */
import { eciToGeodetic, sgp4, type SatRec } from 'satellite.js'
import { gmst, julianDate, RAD } from '@/lib/geo'
import type { TrackPoint } from '@/types'
import { satrecFor } from './catalog'

export interface SatState {
  lat: number
  lon: number
  altKm: number
  /** Earth-fixed position, km (x toward lon 0, z toward the north pole) */
  ecef: [number, number, number]
  /** Inertial speed, km/s */
  velKmS: number
}

/** Minutes since the element set's epoch, as SGP4 wants them. */
export function tsinceMin(satrec: SatRec, ms: number): number {
  return (julianDate(ms) - satrec.jdsatepoch) * 1440
}

/** Epoch of an SGP4 record as epoch ms. */
export function satrecEpochMs(satrec: SatRec): number {
  return (satrec.jdsatepoch - 2440587.5) * 86_400_000
}

export interface Eci {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
}

/** TEME position (km) and velocity (km/s) at `ms`, or null if SGP4 fails (decayed, bad elements). */
export function eciAt(satrec: SatRec, ms: number): Eci | null {
  const pv = sgp4(satrec, tsinceMin(satrec, ms))
  if (!pv) return null
  const p = pv.position
  const v = pv.velocity
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
  return { x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z }
}

/** Geodetic sub-satellite point. */
export interface SubPoint {
  lat: number
  lon: number
  altKm: number
}

export function subPointAt(satrec: SatRec, ms: number): SubPoint | null {
  const e = eciAt(satrec, ms)
  if (!e) return null
  const g = eciToGeodetic(e, gmst(ms))
  return { lat: g.latitude * RAD, lon: g.longitude * RAD, altKm: g.height }
}

export function stateAt(satrec: SatRec, ms: number): SatState | null {
  const e = eciAt(satrec, ms)
  if (!e) return null
  const theta = gmst(ms)
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const g = eciToGeodetic(e, theta)
  return {
    lat: g.latitude * RAD,
    lon: g.longitude * RAD,
    altKm: g.height,
    ecef: [c * e.x + s * e.y, -s * e.x + c * e.y, e.z],
    velKmS: Math.hypot(e.vx, e.vy, e.vz),
  }
}

/** Sampled geodetic track over [t0, t1] (inclusive of both ends). Points where SGP4 fails are skipped. */
export function trackFor(satrec: SatRec, t0: number, t1: number, stepS = 20): TrackPoint[] {
  const out: TrackPoint[] = []
  const step = Math.max(1, stepS) * 1000
  for (let t = t0; t <= t1 + 1e-6; t += step) {
    const p = subPointAt(satrec, t)
    if (p) out.push({ t, lat: p.lat, lon: p.lon, altKm: p.altKm })
  }
  return out
}

/** Main-thread SGP4 for one catalog object. Requires loadCatalog() to have resolved. */
export function propagate(norad: number, ms: number): SatState | null {
  const s = satrecFor(norad)
  return s ? stateAt(s, ms) : null
}

/** Ground track of one catalog object over [t0, t1]. Requires loadCatalog() to have resolved. */
export function groundTrack(norad: number, t0: number, t1: number, stepS = 20): TrackPoint[] {
  const s = satrecFor(norad)
  return s ? trackFor(s, t0, t1, stepS) : []
}
