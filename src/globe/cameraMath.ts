/**
 * Camera pose model and cinematic flights.
 *
 * A pose is "look at a point above the globe from some range, tilted, facing some direction":
 *
 *   d      unit vector from Earth's centre to the look-at point (world frame, see src/lib/geo.ts)
 *   r      radius of the look-at point (1 = surface; > 1 to look at a satellite)
 *   fwd    unit tangent at d: the horizontal direction the camera faces (screen-up when tilt = 0)
 *   range  distance from the look-at point to the camera
 *   tilt   0 = straight down; π/2 = level with the horizon
 *   shift  lens shift in NDC, to frame the subject off-centre without changing perspective
 *
 * Storing the facing as a vector (not a heading angle) keeps the model free of singularities at the poles.
 * Flights interpolate the look-at point along the great circle and carry the facing in the path's own
 * parallel-transported frame, so a flight over a pole never flips the camera. Range is interpolated in log
 * space, with an optional altitude arc for long hops; everything is driven by one eased parameter.
 */
import { Vector3 } from 'three'
import { clamp, DEG, lerp, RAD } from '@/lib/geo'

export interface Pose {
  d: Vector3
  fwd: Vector3
  r: number
  range: number
  tilt: number
  shiftX: number
  shiftY: number
}

const Y = new Vector3(0, 1, 0)
const X = new Vector3(1, 0, 0)

export function createPose(): Pose {
  return { d: new Vector3(1, 0, 0), fwd: new Vector3(0, 1, 0), r: 1, range: 2.5, tilt: 0, shiftX: 0, shiftY: 0 }
}

export function copyPose(src: Pose, out: Pose): Pose {
  out.d.copy(src.d)
  out.fwd.copy(src.fwd)
  out.r = src.r
  out.range = src.range
  out.tilt = src.tilt
  out.shiftX = src.shiftX
  out.shiftY = src.shiftY
  return out
}

export function clonePose(p: Pose): Pose {
  return copyPose(p, createPose())
}

/** Local east and north unit vectors at unit vector d. At the exact pole, east falls back to lon 0's east. */
export function eastNorth(d: Vector3, east: Vector3, north: Vector3): void {
  east.set(d.z, 0, -d.x)
  const l = east.length()
  if (l < 1e-9) east.set(0, 0, -1)
  else east.multiplyScalar(1 / l)
  north.crossVectors(d, east)
}

const _e = new Vector3()
const _n = new Vector3()

/** Horizontal direction at d for a compass heading (radians clockwise from north). */
export function fwdFromHeading(d: Vector3, heading: number, out: Vector3): Vector3 {
  eastNorth(d, _e, _n)
  return out.copy(_n).multiplyScalar(Math.cos(heading)).addScaledVector(_e, Math.sin(heading))
}

/** Compass heading (radians clockwise from north) of a tangent direction at d. */
export function headingOf(d: Vector3, fwd: Vector3): number {
  eastNorth(d, _e, _n)
  return Math.atan2(fwd.dot(_e), fwd.dot(_n))
}

export function latLonOfDir(d: Vector3): { lat: number; lon: number } {
  return { lat: Math.asin(clamp(d.y, -1, 1)) * RAD, lon: Math.atan2(-d.z, d.x) * RAD }
}

export function dirFromLatLon(lat: number, lon: number, out = new Vector3()): Vector3 {
  const la = lat * DEG
  const lo = lon * DEG
  const c = Math.cos(la)
  return out.set(c * Math.cos(lo), Math.sin(la), -c * Math.sin(lo))
}

export interface PoseSpec {
  lat: number
  lon: number
  /** degrees clockwise from north */
  headingDeg?: number
  range: number
  /** radians */
  tilt?: number
  r?: number
  shiftX?: number
  shiftY?: number
}

export function makePose(s: PoseSpec, out = createPose()): Pose {
  dirFromLatLon(s.lat, s.lon, out.d)
  fwdFromHeading(out.d, (s.headingDeg ?? 0) * DEG, out.fwd)
  out.r = s.r ?? 1
  out.range = s.range
  out.tilt = s.tilt ?? 0
  out.shiftX = s.shiftX ?? 0
  out.shiftY = s.shiftY ?? 0
  return out
}

/** Camera position, up vector and look-at target for a pose. */
export function poseToCamera(p: Pose, outPos: Vector3, outUp: Vector3, outTarget: Vector3): void {
  outTarget.copy(p.d).multiplyScalar(p.r)
  const ct = Math.cos(p.tilt)
  const st = Math.sin(p.tilt)
  outPos.copy(outTarget).addScaledVector(p.d, p.range * ct).addScaledVector(p.fwd, -p.range * st)
  outUp.copy(p.fwd).multiplyScalar(ct).addScaledVector(p.d, st).normalize()
}

/** Rotate v about unit axis k by angle a (right-handed), Rodrigues' formula. `out` may alias `v`. */
export function rotateAbout(v: Vector3, k: Vector3, a: number, out: Vector3): Vector3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const kv = k.dot(v)
  const cx = k.y * v.z - k.z * v.y
  const cy = k.z * v.x - k.x * v.z
  const cz = k.x * v.y - k.y * v.x
  return out.set(
    v.x * c + cx * s + k.x * kv * (1 - c),
    v.y * c + cy * s + k.y * kv * (1 - c),
    v.z * c + cz * s + k.z * kv * (1 - c),
  )
}

/** Signed angle that rotates `from` onto `to` about `axis` (both assumed ⟂ axis). */
export function signedAngle(from: Vector3, to: Vector3, axis: Vector3): number {
  const cx = from.y * to.z - from.z * to.y
  const cy = from.z * to.x - from.x * to.z
  const cz = from.x * to.y - from.y * to.x
  return Math.atan2(cx * axis.x + cy * axis.y + cz * axis.z, from.dot(to))
}

export const wrapPi = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI))

/** Re-project fwd onto the tangent plane at d and normalise (guards against drift). */
export function orthonormalize(p: Pose): void {
  p.d.normalize()
  p.fwd.addScaledVector(p.d, -p.fwd.dot(p.d))
  if (p.fwd.lengthSq() < 1e-12) fwdFromHeading(p.d, 0, p.fwd)
  else p.fwd.normalize()
}

// ───────────────────────────── flights ─────────────────────────────

export interface FlightPlan {
  /** seconds */
  duration: number
  /** extra log-range at mid-flight (altitude arc), 0 for none */
  bump: number
}

export const FLIGHT_MIN_S = 2.4
export const FLIGHT_MAX_S = 3.6

/** Duration and altitude arc for a flight. Long hops between close views pull back to see the curvature. */
export function planFlight(a: Pose, b: Pose): FlightPlan {
  const theta = Math.acos(clamp(a.d.dot(b.d), -1, 1))
  const dl = Math.abs(Math.log(b.range / a.range))
  const duration = FLIGHT_MIN_S + (FLIGHT_MAX_S - FLIGHT_MIN_S) * clamp(theta / 2 + dl / 3, 0, 1)
  const peak = Math.min(3.2, theta * 1.3)
  const hi = Math.max(a.range, b.range)
  const bump = peak > hi ? Math.log(peak / hi) : 0
  return { duration, bump }
}

const _n1 = new Vector3()
const _ta = new Vector3()
const _tb = new Vector3()
const _tt = new Vector3()
const _d = new Vector3()

/**
 * Pose at eased progress t ∈ [0, 1] of the flight from a to b. `out` must not alias a or b.
 * Endpoints are exact: t = 0 gives a, t = 1 gives b.
 */
export function interpolatePose(a: Pose, b: Pose, t: number, bump: number, out: Pose): Pose {
  const dot = clamp(a.d.dot(b.d), -1, 1)
  const theta = Math.acos(dot)
  if (theta < 1e-7) {
    out.d.copy(a.d).lerp(b.d, t).normalize()
    const phi = signedAngle(a.fwd, b.fwd, out.d)
    rotateAbout(a.fwd, out.d, phi * t, out.fwd)
  } else {
    _n1.crossVectors(a.d, b.d)
    if (_n1.lengthSq() < 1e-14) _n1.crossVectors(a.d, Math.abs(a.d.y) < 0.9 ? Y : X) // antipodal: any great circle
    _n1.normalize()
    rotateAbout(a.d, _n1, theta * t, _d)
    out.d.copy(_d)
    // Facing relative to the path's tangent (parallel transport along the great circle).
    _ta.crossVectors(_n1, a.d)
    _tb.crossVectors(_n1, b.d)
    _tt.crossVectors(_n1, out.d)
    const relA = signedAngle(_ta, a.fwd, a.d)
    const relB = signedAngle(_tb, b.fwd, b.d)
    const rel = relA + wrapPi(relB - relA) * t
    rotateAbout(_tt, out.d, rel, out.fwd)
  }
  if (t >= 1) {
    out.d.copy(b.d)
    out.fwd.copy(b.fwd)
  }
  orthonormalize(out)
  const s = Math.sin(Math.PI * clamp(t, 0, 1))
  out.range = Math.exp(lerp(Math.log(a.range), Math.log(b.range), t) + bump * s)
  // Level the camera while it is high up, so a long hop reads as a clean arc over the globe.
  const relax = clamp(bump / 0.6, 0, 1) * 0.85
  out.tilt = lerp(a.tilt, b.tilt, t) * (1 - relax * s)
  out.r = lerp(a.r, b.r, t)
  out.shiftX = lerp(a.shiftX, b.shiftX, t)
  out.shiftY = lerp(a.shiftY, b.shiftY, t)
  return out
}

// ───────────────────────────── easing ─────────────────────────────

/** CSS-style cubic-bezier timing function. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let u = x
    for (let i = 0; i < 8; i++) {
      const err = sampleX(u) - x
      if (Math.abs(err) < 1e-6) return sampleY(u)
      const dx = slopeX(u)
      if (Math.abs(dx) < 1e-6) break
      u -= err / dx
    }
    let lo = 0
    let hi = 1
    u = x
    for (let i = 0; i < 30; i++) {
      const v = sampleX(u)
      if (Math.abs(v - x) < 1e-6) break
      if (v < x) lo = u
      else hi = u
      u = (lo + hi) / 2
    }
    return sampleY(u)
  }
}

/** --ease-in-out from the design tokens */
export const easeInOut = cubicBezier(0.6, 0, 0.2, 1)
/** --ease-out from the design tokens */
export const easeOut = cubicBezier(0.2, 0, 0, 1)

/** Frame-rate independent exponential approach factor for a time constant tau (s). */
export const damp = (dt: number, tau: number) => 1 - Math.exp(-dt / Math.max(tau, 1e-4))
