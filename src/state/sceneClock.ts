/**
 * Per-frame simulation time without React. The globe's Clock writes `sceneClock` every frame; UI that must
 * move every frame (replay scrubber, timeline playhead, plan-view satellite) subscribes with useSceneFrame
 * and writes transforms directly. store.simTime remains the ~10 Hz React value for text readouts.
 */
import { useEffect, useRef } from 'react'

export const sceneClock = { simTime: Date.now(), mode: 'live' as 'live' | 'scrub' | 'replay' }

type Sub = (simTime: number) => void
const subs = new Set<Sub>()
let raf = 0

function loop() {
  raf = subs.size ? requestAnimationFrame(loop) : 0
  const t = sceneClock.simTime
  for (const cb of subs) cb(t)
}

/** Call `cb(simTime)` once per animation frame while mounted (one shared rAF loop for all subscribers). */
export function useSceneFrame(cb: (simTime: number) => void, enabled = true): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    if (!enabled) return
    const sub: Sub = (t) => ref.current(t)
    subs.add(sub)
    if (!raf) raf = requestAnimationFrame(loop)
    return () => {
      subs.delete(sub)
      if (!subs.size && raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
  }, [enabled])
}
