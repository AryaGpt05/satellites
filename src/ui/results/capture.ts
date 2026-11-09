/**
 * The capture moment, as the panel sees it (owner C4): the globe's replay clock carrying sim time across the
 * pass's closest approach. That is the instant the globe's scan line crosses the place (shockwave, reticle
 * lock, "ACQUIRED"), so the panel's pushbroom reveal (or, for a photo already shown, the echo of its scan)
 * starts on the same frame. Read per frame from sceneClock (no store traffic, no React renders).
 *
 * R3-3: the panel reads sceneClock AFTER the globe has written it for the frame, the value the HUD's acquisition
 * readout shows in that same frame. The shared useSceneFrame loop starts at boot (the HUD clock), so it runs ahead
 * of the globe's own rAF every frame and would read the previous frame's time: a countdown one tick behind the HUD
 * at every second boundary. This loop re-arms its rAF from a task posted after each frame, which puts it after the
 * globe's (registered during the frame) in the next one.
 */
import { useEffect, useRef } from 'react'
import { sceneClock } from '@/state/sceneClock'
import { REPLAY_PAD_MS } from './lib/replay'

/** A sim-time step larger than this in one frame is a jump (a pass selected), never a crossing. */
const JUMP_MS = 5 * 60_000

type Mode = typeof sceneClock.mode
type FrameSub = (simTime: number, mode: Mode) => void

const subs = new Set<FrameSub>()
let armed = false
let chan: MessageChannel | null = null

function frame() {
  armed = false
  const t = sceneClock.simTime
  const mode = sceneClock.mode
  for (const cb of subs) cb(t, mode)
  rearm()
}

function rearm() {
  if (armed || !subs.size || typeof requestAnimationFrame === 'undefined') return
  armed = true
  if (!chan && typeof MessageChannel !== 'undefined') {
    chan = new MessageChannel()
    chan.port1.onmessage = () => requestAnimationFrame(frame)
  }
  if (chan) chan.port2.postMessage(0)
  else window.setTimeout(() => requestAnimationFrame(frame), 0)
}

/** Call `cb(simTime, mode)` once per frame, after the globe has written that frame's sim time. */
export function useAfterSceneFrame(cb: FrameSub, enabled = true): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    if (!enabled) return
    const sub: FrameSub = (t, m) => ref.current(t, m)
    subs.add(sub)
    rearm()
    return () => {
      subs.delete(sub)
    }
  }, [enabled])
}

export interface CaptureCallbacks {
  /** Sim time crossed `tc` during replay playback */
  onCapture: () => void
  /** Every frame while enabled (countdowns) */
  onFrame?: (simTime: number, mode: Mode) => void
}

export function useCaptureMoment(tc: number | undefined, cb: CaptureCallbacks, enabled = true): void {
  const prev = useRef<number | null>(null)
  const ref = useRef(cb)
  ref.current = cb
  useAfterSceneFrame(
    (t, mode) => {
      if (tc === undefined) return
      const p = prev.current
      prev.current = mode === 'replay' ? t : null
      ref.current.onFrame?.(t, mode)
      if (mode === 'replay' && p !== null && p < tc && t >= tc && t - p < JUMP_MS) ref.current.onCapture()
    },
    enabled && tc !== undefined,
  )
}

/** "T−00:01:12" / "T+00:00:03" (sim time to closest approach): the same words as the globe's HUD readout. */
export function countdown(simTime: number, tc: number): string {
  const d = Math.round((simTime - tc) / 1000)
  const a = Math.abs(d)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `T${d < 0 ? '−' : '+'}${p2(Math.floor(a / 3600))}:${p2(Math.floor((a % 3600) / 60))}:${p2(a % 60)}`
}

/** The approach the replay clock can be on before the capture (the replay window's lead, with room for the rewind). */
const APPROACH_MS = 2 * REPLAY_PAD_MS

/**
 * The awaiting chip's countdown (R3-3): only while the replay clock is actually on this pass's approach. Anywhere
 * else (the live clock days later, a scrub elsewhere, the first frames before the globe seeds the replay) it is
 * neutral (''), never "T+175:34:22".
 */
export function awaitCountdown(simTime: number, mode: Mode, tc: number): string {
  if (mode !== 'replay' || simTime > tc || tc - simTime > APPROACH_MS) return ''
  return countdown(simTime, tc)
}
