/**
 * Phase-lock 1 Hz blinks to the wall-clock second (DESIGN §4: "blinking signal dot, 1 Hz, 50% duty").
 *
 * A CSS animation starts whenever its element is first styled, so two live dots mounted a few hundred
 * ms apart blink out of step with each other and with the clock digits beside them. This sets each
 * infinite 1 s animation's time so it is "on" for the first half of every UTC second, the same frame
 * the clock ticks over. It only touches animations that have drifted, but reading them forces a style
 * recalc, so it runs on mount and when a blinking element (`data-blink`) appears, not on every render.
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
 * Keep the blinks under `ref` locked to the wall second: on mount, when the tab becomes visible again,
 * and when a new blinking element (marked `data-blink`) appears inside it. Never after every render:
 * getAnimations() forces a style recalc, and the HUD re-renders every second.
 */
export function useWallSecondSync(ref: RefObject<Element | null>, subtree = true): void {
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    // Only the marked blinkers (and their pseudo-elements), at the top of a frame: styles are clean
    // there, so reading their animations doesn't force a recalc mid-commit. One frame of drift at
    // mount is invisible.
    const sync = () => {
      const el = ref.current
      if (!el) return
      if (!subtree) return syncToWallSecond(el, false)
      if (el.hasAttribute('data-blink')) syncToWallSecond(el, true)
      el.querySelectorAll('[data-blink]').forEach((b) => syncToWallSecond(b, true))
    }
    let raf = 0
    const later = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          sync()
        })
    }
    later()
    const onVisible = () => {
      if (document.visibilityState === 'visible') later()
    }
    document.addEventListener('visibilitychange', onVisible)
    let mo: MutationObserver | undefined
    if (subtree && typeof MutationObserver !== 'undefined') {
      const blinks = (n: Node) => n instanceof Element && (n.hasAttribute('data-blink') || !!n.querySelector('[data-blink]'))
      mo = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === 'attributes' ? blinks(r.target) : [...r.addedNodes].some(blinks)) return later()
        }
      })
      mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-blink'] })
    }
    return () => {
      cancelAnimationFrame(raf)
      mo?.disconnect()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ref, subtree])
}
