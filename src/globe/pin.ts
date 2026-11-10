/**
 * Dropping a pin on the globe (pure parts, unit-tested): which point of the Earth is under the pointer, and which
 * pointer gestures drop a pin.
 *
 *   mouse        a click: button 0, no modifier, released within CLICK_SLOP_PX and CLICK_MAX_MS of the press
 *   touch / pen  a press held still for HOLD_MS (a quick tap stays the satellite pick: SatelliteField)
 *
 * A drag, a pinch, a turn (right button or a modifier) or a wheel never drops one. A click on space clears the pin.
 */
import { Vector3, type Camera } from 'three'
import { worldToLatLon } from '@/lib/geo'

/** A mouse press that moves more than this (CSS px) is a drag. */
export const CLICK_SLOP_PX = 5
/** A mouse press held longer than this is not a click (a grab that changed its mind). */
export const CLICK_MAX_MS = 600
/** A finger held still this long drops the pin. */
export const HOLD_MS = 450
/** …and "still" means within this many CSS px of where it went down (a finger wobbles more than a mouse). */
export const HOLD_SLOP_PX = 9
/** The press feedback ring starts drawing this long after the finger goes down (a tap never shows it). */
export const HOLD_FEEDBACK_DELAY_MS = 140

const _near = new Vector3()
const _dir = new Vector3()

/**
 * The point of the unit sphere (the Earth's surface in world units) under normalised device coordinates (x, y), or
 * null when the ray misses the planet. Uses the camera's own matrices, so an off-axis lens shift is accounted for.
 */
export function pickSurface(ndcX: number, ndcY: number, camera: Camera): { lat: number; lon: number } | null {
  _near.set(ndcX, ndcY, -1).unproject(camera)
  _dir.set(ndcX, ndcY, 1).unproject(camera).sub(_near).normalize()
  const hit = raySphere(_near, _dir, 1)
  return hit ? worldToLatLon(hit) : null
}

/** First intersection of the ray `o + t·d` (d unit length, t ≥ 0) with the sphere of `radius` at the origin. */
export function raySphere(o: Vector3, d: Vector3, radius: number, out = new Vector3()): Vector3 | null {
  const b = o.dot(d)
  const c = o.lengthSq() - radius * radius
  const disc = b * b - c
  if (disc < 0) return null
  const s = Math.sqrt(disc)
  let t = -b - s
  if (t < 0) t = -b + s // the origin is inside the sphere (never for the camera, but well defined)
  if (t < 0) return null
  return out.copy(d).multiplyScalar(t).add(o)
}

export interface PressStart {
  x: number
  y: number
  at: number
  pointerType: string
  button: number
  modifier: boolean
}

/** A mouse press released at (x, y) at `at`: a click that drops (or moves) the pin? */
export function isPinClick(p: PressStart, x: number, y: number, at: number): boolean {
  return (
    p.pointerType === 'mouse' &&
    p.button === 0 &&
    !p.modifier &&
    Math.hypot(x - p.x, y - p.y) <= CLICK_SLOP_PX &&
    at - p.at <= CLICK_MAX_MS
  )
}

/** A touch or pen press that moved to (x, y): still a hold? */
export const holdStill = (p: PressStart, x: number, y: number) => Math.hypot(x - p.x, y - p.y) <= HOLD_SLOP_PX

/** Pin coordinates, rounded to what the search uses (5 decimals: ~1 m), so a pin and its search name one spot. */
export const roundPin = (v: number) => Math.round(v * 1e5) / 1e5
