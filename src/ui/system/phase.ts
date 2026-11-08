/**
 * Phase-lock 1 Hz blinks to the wall-clock second (DESIGN §4: "blinking signal dot, 1 Hz, 50% duty").
 *
 * A CSS animation starts whenever its element is first styled, so two live dots mounted a few hundred
 * ms apart blink out of step with each other and with the clock digits beside them. This sets each
 * infinite 1 s animation's time so it is "on" for the first half of every UTC second, the same frame
 * the clock ticks over. Cheap enough to call after every render: it only touches animations that have
 * drifted.
 */
import { useLayoutEffect, type RefObject } from 'react'

const PERIOD_MS = 1000
/** Animations within this many ms of the wall-clock phase are left alone. */
const TOLERANCE_MS = 24

/** Align every infinite 1 s CSS animation on `el` (and, with `subtree`, inside it) to the wall second. */
export function syncToWallSecond(el: Element | null | undefined, subtree = false): void {
  if (!el || typeof el.getAnimations !== 'function') return
  const wall = Date.now() % PERIOD_MS
  for (const a of el.getAnimations({ subtree })) {
    const timing = a.effect?.getTiming()
    if (!timing || timing.duration !== PERIOD_MS || timing.iterations !== Infinity) continue
    const delay = Number(timing.delay) || 0
    // Local time = currentTime − delay; we want local time ≡ wall (mod 1 s).
    const current = Number(a.currentTime ?? 0)
    const drift = (((current - delay - wall) % PERIOD_MS) + PERIOD_MS) % PERIOD_MS
    if (Math.min(drift, PERIOD_MS - drift) <= TOLERANCE_MS) continue
    a.currentTime = wall + delay + PERIOD_MS * Math.max(1, Math.floor(current / PERIOD_MS))
  }
}

/**
 * Keep the blinks under `ref` locked to the wall second. Re-checks after every render (new blinking
 * elements appear as state changes) and when the tab becomes visible again.
 */
export function useWallSecondSync(ref: RefObject<Element | null>, subtree = true): void {
  useLayoutEffect(() => {
    syncToWallSecond(ref.current, subtree)
  })
  useLayoutEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncToWallSecond(ref.current, subtree)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [ref, subtree])
}
