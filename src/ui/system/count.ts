/**
 * Pure count-up model behind <Num> (kept DOM-free so it is unit-tested).
 *
 * A count eases from `from` to `to` over `duration` ms starting at `start` (performance.now() ms; it may
 * lie in the future for a delayed count). Re-targeting mid-count starts the next leg from the value on
 * screen at that instant, so an interrupted count never snaps back to where the last one began.
 */
import { easeOut } from '@/lib/ease'

export interface CountLeg {
  from: number
  to: number
  /** performance.now() ms when the leg starts moving */
  start: number
  duration: number
}

/** The value a leg shows at `now`, on the --ease-out curve. */
export function sampleLeg(leg: CountLeg, now: number): number {
  if (leg.duration <= 0) return leg.to
  const t = Math.min(1, Math.max(0, (now - leg.start) / leg.duration))
  return leg.from + (leg.to - leg.from) * easeOut(t)
}

/** True once a leg has reached its target. */
export const legDone = (leg: CountLeg, now: number) => now >= leg.start + leg.duration

/**
 * The next leg toward `to`. `current` is the leg in flight (or undefined for the first count, which
 * starts from `initial`). The new leg starts where the old one is at `now`.
 */
export function retarget(current: CountLeg | undefined, to: number, now: number, duration: number, delay = 0, initial = 0): CountLeg {
  const from = current ? sampleLeg(current, now) : initial
  return { from, to, start: now + delay, duration }
}
