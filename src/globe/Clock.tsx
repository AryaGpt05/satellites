/**
 * The globe owns the frame loop. Every frame, before anything else (FRAME.clock):
 *  - advance simTime per store.timeMode (see clock.ts), keep it in the runtime, write it back to the store
 *    at ~10 Hz so React consumers stay calm;
 *  - compute the sun direction and GMST for that instant (shared uniforms);
 *  - drift the clouds (wall time, very slowly; frozen under prefers-reduced-motion);
 *  - publish the device pixel ratio for pixel-exact strokes.
 */
import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import { gmst, sunDirectionWorld } from '@/lib/geo'
import { useApp } from '@/state/store'
import { createClock, stepClock } from './clock'
import { FRAME, useRuntime } from './runtime'

/** One full cloud-layer drift every 8 hours of wall time: perceptible only if you stare. */
const CLOUD_DRIFT_PER_S = 1 / (8 * 3600)

export function Clock() {
  const rt = useRuntime()
  const clock = useRef(createClock(useApp.getState().simTime, useApp.getState().timeMode, Date.now()))

  useFrame((state, dt) => {
    const st = useApp.getState()
    const now = Date.now()
    const { write } = stepClock(clock.current, {
      mode: st.timeMode,
      storeSimTime: st.simTime,
      replayRate: st.replayRate,
      dt,
      now,
    })
    rt.prevSimTime = rt.simTime
    rt.simTime = clock.current.simTime
    if (write !== undefined) st.setSimTime(write)

    sunDirectionWorld(rt.simTime, rt.sunDir)
    rt.gmst = gmst(rt.simTime)
    // Sampling at uv + offset with a decreasing offset moves the weather eastward, like the westerlies.
    if (!rt.reducedMotion)
      rt.uniforms.uCloudOffset.value = (rt.uniforms.uCloudOffset.value + 1 - Math.min(dt, 0.1) * CLOUD_DRIFT_PER_S) % 1
    rt.uniforms.uPx.value = state.gl.getPixelRatio()
  }, FRAME.clock)

  return null
}
