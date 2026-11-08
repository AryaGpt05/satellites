/**
 * Replay window maths (pure). The store actions that use it live in ../actions.ts.
 *
 * A pushbroom pass is in-swath for only ~20–40 s (a 290 km swath at 6.8 km/s), which would be over
 * in about a second at 30×. So the replay window pads the in-field window to at least ±90 s around
 * closest approach: the swath visibly approaches, sweeps the place, and leaves (≈ 6 s at 30×).
 */
import type { Pass } from '@/types'

export const REPLAY_PAD_MS = 90_000
export const DEFAULT_REPLAY_RATE = 30
export const REPLAY_RATES = [1, 10, 30, 60] as const

export function replayWindow(p: Pick<Pass, 'tStart' | 'tEnd' | 'tClosest'>): [number, number] {
  const a = Math.min(p.tStart, p.tClosest - REPLAY_PAD_MS)
  const b = Math.max(p.tEnd, p.tClosest + REPLAY_PAD_MS)
  return [a, b]
}

/** 0..1 position of t in the window (clamped). */
export function windowFraction(t: number, [a, b]: [number, number]): number {
  return b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0
}

/** Whether the replay has reached (or passed) the end of the window. */
export const replayDone = (t: number, w: [number, number]) => t >= w[1]
