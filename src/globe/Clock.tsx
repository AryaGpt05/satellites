/**
 * The globe owns the frame loop. Every frame, before anything else (FRAME.clock):
 *  - advance simTime per store.timeMode (see clock.ts), keep it in the runtime and in sceneClock (per-frame time
 *    for UI that moves every frame), and write it back to the store at ~10 Hz so React consumers stay calm;
 *  - hold a replay at its start while the camera is still flying, so the sweep begins on arrival (M05);
 *  - compute the sun direction and GMST for that instant (shared uniforms). Across a time jump (a pass selected
 *    or deselected: days of sim time in one frame) the sun GLIDES from where it was, in step with the camera
 *    flight (or over 900 ms without one), so the terminator sweeps instead of the planet flipping night↔day (M04);
 *  - drift the clouds (wall time, very slowly; frozen under prefers-reduced-motion);
 *  - track the app phase and when it was entered (texture / DPR gating), and publish the device pixel ratio.
 */
import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import { Vector3 } from 'three'
import { gmst, sunDirectionWorld } from '@/lib/geo'
import { easeInOut } from '@/lib/ease'
import { sceneClock } from '@/state/sceneClock'
import { useApp } from '@/state/store'
import { createClock, stepClock } from './clock'
import { FRAME, useRuntime } from './runtime'

/** One full cloud-layer drift every 8 hours of wall time: perceptible only if you stare. */
const CLOUD_DRIFT_PER_S = 1 / (8 * 3600)
/** A sim-time step larger than this in one frame is a jump, not playback. */
export const TIME_JUMP_MS = 5 * 60_000
/** Sun glide across a jump when no camera flight carries it. */
const SUN_GLIDE_MS = 900

/** Spherical interpolation between unit vectors (falls back to a normalised lerp when nearly parallel). */
export function slerpUnit(a: Vector3, b: Vector3, t: number, out: Vector3): Vector3 {
  const dot = Math.max(-1, Math.min(1, a.dot(b)))
  const theta = Math.acos(dot)
  if (theta < 1e-5) return out.copy(a).lerp(b, t).normalize()
  const s = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / s
  const wb = Math.sin(t * theta) / s
  return out.set(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb).normalize()
}

export function Clock() {
  const rt = useRuntime()
  const clock = useRef(createClock(useApp.getState().simTime, useApp.getState().timeMode, Date.now()))
  const glide = useRef({
    active: false,
    from: new Vector3(),
    to: new Vector3(),
    /** 'pending' until the frame after the jump tells us whether a flight carries it */
    mode: 'pending' as 'pending' | 'flight' | 'wall',
    flightId: -1,
    /** Flight progress when the glide attached to it (a flight may already be under way) */
    p0: 0,
    k: 0,
    wallFrom: 0,
    wallAt: 0,
  })

  useFrame((state, dt) => {
    const st = useApp.getState()
    const now = Date.now()
    const perfNow = performance.now()

    if (st.phase !== rt.phase) {
      rt.phase = st.phase
      rt.phaseEnteredAt = perfNow
    }

    // Replay waits for the camera: the sweep starts on arrival, not mid-flight.
    const hold = st.timeMode === 'replay' && rt.camera.flying
    const { write } = stepClock(clock.current, {
      mode: st.timeMode,
      storeSimTime: st.simTime,
      replayRate: st.replayRate,
      dt: hold ? 0 : dt,
      now,
    })
    rt.prevSimTime = rt.simTime
    rt.simTime = clock.current.simTime
    sceneClock.simTime = rt.simTime
    sceneClock.mode = st.timeMode
    if (write !== undefined) st.setSimTime(write)

    // ── sun, with a glide across time jumps
    const g = glide.current
    const jumped = Math.abs(rt.simTime - rt.prevSimTime) > TIME_JUMP_MS
    if (jumped) {
      rt.timeJump.id++
      rt.timeJump.at = perfNow
      rt.timeJump.fromSimTime = rt.prevSimTime
    }
    if (jumped && !rt.reducedMotion) {
      // Start from wherever the sun is drawn now (possibly mid-glide).
      g.from.copy(rt.sunDir)
      g.active = true
      g.mode = 'pending'
      g.k = 0
    } else if (jumped) {
      g.active = false // reduced motion: keep the cut (the camera's 300 ms ink fade covers it)
    }
    sunDirectionWorld(rt.simTime, g.to)
    if (g.active) {
      if (g.mode === 'pending' && !jumped) {
        // The camera ran after us on the jump frame: a flight that started then carries the glide.
        if (rt.camera.flying) {
          g.mode = 'flight'
          g.flightId = rt.camera.flightId
          g.p0 = Math.min(0.95, rt.camera.progress)
        } else {
          g.mode = 'wall'
          g.wallFrom = 0
          g.wallAt = perfNow
        }
      }
      if (g.mode === 'flight' && (!rt.camera.flying || rt.camera.flightId !== g.flightId)) {
        // Interrupted (gesture) or retargeted: finish on wall time from where we are.
        g.mode = 'wall'
        g.wallFrom = g.k
        g.wallAt = perfNow
      }
      if (g.mode === 'flight') g.k = Math.max(g.k, (rt.camera.progress - g.p0) / (1 - g.p0))
      else if (g.mode === 'wall') g.k = g.wallFrom + (1 - g.wallFrom) * easeInOut(Math.min(1, (perfNow - g.wallAt) / SUN_GLIDE_MS))
      if (g.k >= 1) {
        g.active = false
        rt.sunDir.copy(g.to)
      } else slerpUnit(g.from, g.to, g.k, rt.sunDir)
    } else {
      rt.sunDir.copy(g.to)
    }

    rt.gmst = gmst(rt.simTime)
    // Sampling at uv + offset with a decreasing offset moves the weather eastward, like the westerlies.
    if (!rt.reducedMotion)
      rt.uniforms.uCloudOffset.value = (rt.uniforms.uCloudOffset.value + 1 - Math.min(dt, 0.1) * CLOUD_DRIFT_PER_S) % 1
    rt.uniforms.uPx.value = state.gl.getPixelRatio()
  }, FRAME.clock)

  return null
}
