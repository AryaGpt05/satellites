/**
 * The capture moment, as the panel sees it (owner C4): the globe's replay clock carrying sim time across the
 * pass's closest approach. That is the instant the globe's scan line crosses the place (shockwave, reticle
 * lock, "ACQUIRED"), so the panel's pushbroom reveal (or, for a photo already shown, the echo of its scan)
 * starts on the same frame. Read per frame from sceneClock (no store traffic, no React renders).
 */
import { useRef } from 'react'
import { sceneClock, useSceneFrame } from '@/state/sceneClock'

/** A sim-time step larger than this in one frame is a jump (a pass selected), never a crossing. */
const JUMP_MS = 5 * 60_000

export interface CaptureCallbacks {
  /** Sim time crossed `tc` during replay playback */
  onCapture: () => void
  /** Every frame while enabled (countdowns) */
  onFrame?: (simTime: number, mode: typeof sceneClock.mode) => void
}

export function useCaptureMoment(tc: number | undefined, cb: CaptureCallbacks, enabled = true): void {
  const prev = useRef<number | null>(null)
  const ref = useRef(cb)
  ref.current = cb
  useSceneFrame(
    (t) => {
      if (tc === undefined) return
      const mode = sceneClock.mode
      const p = prev.current
      prev.current = mode === 'replay' ? t : null
      ref.current.onFrame?.(t, mode)
      if (mode === 'replay' && p !== null && p < tc && t >= tc && t - p < JUMP_MS) ref.current.onCapture()
    },
    enabled && tc !== undefined,
  )
}

/** "T−00:01:12" / "T+00:00:03" (sim time to closest approach). */
export function countdown(simTime: number, tc: number): string {
  const d = Math.round((simTime - tc) / 1000)
  const a = Math.abs(d)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `T${d < 0 ? '−' : '+'}${p2(Math.floor(a / 3600))}:${p2(Math.floor((a % 3600) / 60))}:${p2(a % 60)}`
}
