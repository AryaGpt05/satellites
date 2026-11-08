/**
 * Damped direct-manipulation controls on the camera pose (see cameraMath.ts):
 *   drag            move over the globe (the surface follows the pointer), with inertia
 *   wheel / pinch   zoom (log range, eased)
 *   right-drag, or shift/ctrl + drag   turn (heading) and tilt
 *
 * The controller only accumulates input; CameraDirector applies it to the pose each frame, so a flight can
 * take over (or be interrupted) cleanly. Listeners live on the canvas element; overlay UI above it simply
 * doesn't forward events.
 */
import { Vector3 } from 'three'
import { clamp, DEG } from '@/lib/geo'
import { orthonormalize, rotateAbout, type Pose } from './cameraMath'
import { MAX_RANGE, MIN_RANGE } from './framing'

export interface ControlInput {
  /** Accumulated pan since the last frame, in screen px (x right, y down) */
  panX: number
  panY: number
  /** Accumulated turn/tilt since the last frame, px */
  turnX: number
  turnY: number
  /** Accumulated log-zoom since the last frame (positive = out) */
  zoom: number
  dragging: boolean
  /** performance.now() of the last user input */
  lastInputAt: number
  /** Bumped on every pointerdown / wheel: lets the director interrupt flights */
  gestureId: number
}

export function createControlInput(): ControlInput {
  return { panX: 0, panY: 0, turnX: 0, turnY: 0, zoom: 0, dragging: false, lastInputAt: -Infinity, gestureId: 0 }
}

/**
 * Attach pointer / wheel listeners. `enabled()` is consulted on each gesture start, so the director can
 * disable manipulation during phases where the camera is scripted. Returns a detach function.
 */
export function attachControls(el: HTMLElement, input: ControlInput, enabled: () => boolean): () => void {
  const pointers = new Map<number, { x: number; y: number }>()
  let mode: 'pan' | 'turn' | null = null
  let pinchDist = 0

  const mark = () => {
    input.lastInputAt = performance.now()
  }

  const onDown = (e: PointerEvent) => {
    if (!enabled()) return
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return
    el.setPointerCapture?.(e.pointerId)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    mode = e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey ? 'turn' : 'pan'
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
    }
    input.dragging = true
    input.gestureId++
    mark()
  }

  const onMove = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId)
    if (!p) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    p.x = e.clientX
    p.y = e.clientY
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchDist > 0 && d > 0) input.zoom += Math.log(pinchDist / d)
      pinchDist = d
      // Two fingers also pan by half their common motion, which feels anchored.
      input.panX += dx / 2
      input.panY += dy / 2
    } else if (mode === 'turn') {
      input.turnX += dx
      input.turnY += dy
    } else {
      input.panX += dx
      input.panY += dy
    }
    mark()
  }

  const onUp = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return
    if (pointers.size < 2) pinchDist = 0
    if (pointers.size === 0) {
      input.dragging = false
      mode = null
    }
    mark()
  }

  const onWheel = (e: WheelEvent) => {
    if (!enabled()) return
    e.preventDefault()
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    input.zoom += clamp(e.deltaY * unit, -240, 240) * 0.0016
    input.gestureId++
    mark()
  }

  const onContext = (e: Event) => e.preventDefault()

  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onUp)
  el.addEventListener('wheel', onWheel, { passive: false })
  el.addEventListener('contextmenu', onContext)
  return () => {
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('pointercancel', onUp)
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('contextmenu', onContext)
  }
}

// ───────────────────────────── applying input ─────────────────────────────

export interface ControlState {
  /** Angular velocity of the look-at point (world axis × rad/s), for inertia */
  spin: Vector3
  /** Target log-range the pose eases toward */
  zoomTarget: number | null
}

export function createControlState(): ControlState {
  return { spin: new Vector3(), zoomTarget: null }
}

const _right = new Vector3()
const _t = new Vector3()
const _axis = new Vector3()

/** Radians of arc on the globe per screen pixel at the look-at point. */
export function radiansPerPixel(pose: Pose, fovDeg: number, heightPx: number): number {
  return (2 * pose.range * Math.tan((fovDeg * DEG) / 2)) / Math.max(1, heightPx) / Math.max(0.5, pose.r)
}

/**
 * Consume the accumulated input and advance the pose by dt (s). Returns true if the user moved the camera.
 * `northUp` keeps the heading pinned to north (overview), with the look-at latitude clamped off the poles.
 * `minRange` is the near zoom limit (the texture-resolution floor, framing.minRangeFor; decision 6). If the
 * pose is already closer than a newly raised floor, it eases out to it rather than jumping.
 */
export function applyControls(
  pose: Pose,
  input: ControlInput,
  state: ControlState,
  dt: number,
  fovDeg: number,
  heightPx: number,
  northUp: boolean,
  minRange = MIN_RANGE,
): boolean {
  const floor = Math.min(MAX_RANGE, Math.max(MIN_RANGE, minRange))
  let moved = false
  const k = radiansPerPixel(pose, fovDeg, heightPx)

  // Pan: move the look-at point along the screen's right / up directions on the sphere.
  if (input.panX !== 0 || input.panY !== 0) {
    _right.crossVectors(pose.fwd, pose.d) // screen right at tilt 0
    _t.copy(_right).multiplyScalar(-input.panX * k).addScaledVector(pose.fwd, input.panY * k)
    const angle = _t.length()
    if (angle > 0) {
      _axis.crossVectors(pose.d, _t).normalize()
      rotateAbout(pose.d, _axis, angle, pose.d)
      rotateAbout(pose.fwd, _axis, angle, pose.fwd)
      // Velocity estimate for inertia (exponentially smoothed).
      const w = Math.min(1, dt > 0 ? dt / 0.05 : 1)
      state.spin.multiplyScalar(1 - w).addScaledVector(_axis, (angle / Math.max(dt, 1 / 240)) * w)
      moved = true
    }
    input.panX = 0
    input.panY = 0
  } else if (!input.dragging && state.spin.lengthSq() > 1e-10) {
    // Inertia after release.
    const speed = state.spin.length()
    _axis.copy(state.spin).divideScalar(speed)
    const angle = speed * dt
    rotateAbout(pose.d, _axis, angle, pose.d)
    rotateAbout(pose.fwd, _axis, angle, pose.fwd)
    state.spin.multiplyScalar(Math.exp(-dt / 0.32))
    moved = true
  } else if (input.dragging) {
    state.spin.multiplyScalar(Math.exp(-dt / 0.05)) // holding still stops the throw
  }

  // Turn + tilt.
  if (input.turnX !== 0 || input.turnY !== 0) {
    rotateAbout(pose.fwd, pose.d, -input.turnX * 0.35 * DEG, pose.fwd)
    pose.tilt = clamp(pose.tilt - input.turnY * 0.3 * DEG, 0, 72 * DEG)
    input.turnX = 0
    input.turnY = 0
    moved = true
  }

  // Zoom: ease the range toward the accumulated target.
  if (input.zoom !== 0) {
    const base = state.zoomTarget ?? Math.log(pose.range)
    state.zoomTarget = clamp(base + input.zoom, Math.log(floor), Math.log(MAX_RANGE))
    input.zoom = 0
  }
  if (state.zoomTarget !== null) {
    const cur = Math.log(pose.range)
    const next = cur + (state.zoomTarget - cur) * (1 - Math.exp(-dt / 0.12))
    pose.range = Math.exp(next)
    if (Math.abs(state.zoomTarget - next) < 1e-4) state.zoomTarget = null
    moved = true
  } else if (pose.range < floor * 0.999) {
    pose.range += (floor - pose.range) * (1 - Math.exp(-dt / 0.35))
  }

  if (northUp) {
    // Keep the look-at point off the poles and the view north-up.
    const maxY = Math.sin(80 * DEG)
    if (Math.abs(pose.d.y) > maxY) {
      const s = Math.sign(pose.d.y)
      const h = Math.sqrt(1 - maxY * maxY) / Math.max(1e-9, Math.hypot(pose.d.x, pose.d.z))
      pose.d.set(pose.d.x * h, s * maxY, pose.d.z * h)
      state.spin.set(0, state.spin.y, 0)
    }
  }
  orthonormalize(pose)
  return moved
}
