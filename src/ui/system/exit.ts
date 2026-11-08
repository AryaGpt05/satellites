/**
 * useExitClone: an exit animation for components that the parent unmounts outright
 * (`{phase === 'boot' && <BootScreen/>}`), without an AnimatePresence-style wrapper.
 *
 * On unmount, before React removes the DOM, the element is cloned in place (same parent, same
 * stacking position), made inert, and the clone is animated out with the Web Animations API and then
 * removed. The live tree is gone immediately, so nothing behind it waits for the animation.
 *
 * Cloning copies the last committed frame. If state changed in the same batch as the unmount (e.g. a
 * final "OK" flag), patch the clone in `prepare`. CSS animations inside the clone are frozen at their
 * resting style (a fresh node would otherwise replay its entrance). `onStart` runs once the clone is
 * in the document, for choreography inside it (e.g. clear the text before the curtain lifts).
 *
 * Components unmounted within a few frames of mounting (React StrictMode's simulated unmount in dev)
 * are not cloned.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'
import { prefersReducedMotion } from './motion'

/** Unmounts sooner than this after mounting are not animated (StrictMode's simulated unmount). */
const MIN_LIFETIME_MS = 48

export interface ExitOptions<T extends HTMLElement> {
  keyframes: Keyframe[]
  duration: number
  easing?: string
  delay?: number
  /** Mutate the clone before it animates (fix up text, drop interactive bits). */
  prepare?: (clone: T) => void
  /** Called after the clone is inserted and its exit has started. */
  onStart?: (clone: T, reduced: boolean) => void
  /** Keyframes used under prefers-reduced-motion. Default: a 200 ms fade. */
  reducedKeyframes?: Keyframe[]
}

export function useExitClone<T extends HTMLElement>(ref: RefObject<T | null>, opts: ExitOptions<T>): void {
  const optsRef = useRef(opts)
  optsRef.current = opts
  useLayoutEffect(() => {
    const node = ref.current
    const mountedAt = performance.now()
    return () => {
      const parent = node?.parentNode
      if (!node || !parent || !node.isConnected || typeof node.animate !== 'function') return
      if (performance.now() - mountedAt < MIN_LIFETIME_MS) return
      const o = optsRef.current
      const clone = node.cloneNode(true) as T
      clone.setAttribute('aria-hidden', 'true')
      clone.removeAttribute('role')
      clone.removeAttribute('aria-live')
      clone.inert = true
      clone.style.pointerEvents = 'none'
      clone.style.animation = 'none'
      clone.querySelectorAll<HTMLElement | SVGElement>('*').forEach((el) => {
        el.style.animation = 'none'
        el.removeAttribute('id')
      })
      clone.removeAttribute('id')
      try {
        o.prepare?.(clone)
      } catch {
        /* a failed cosmetic patch must never break the unmount */
      }
      parent.insertBefore(clone, node.nextSibling)
      const reduced = prefersReducedMotion()
      const anim = clone.animate(reduced ? (o.reducedKeyframes ?? [{ opacity: 1 }, { opacity: 0 }]) : o.keyframes, {
        duration: reduced ? 200 : o.duration,
        delay: reduced ? 0 : (o.delay ?? 0),
        easing: o.easing ?? 'cubic-bezier(.6, 0, .2, 1)',
        fill: 'forwards',
      })
      try {
        o.onStart?.(clone, reduced)
      } catch {
        /* cosmetic */
      }
      const remove = () => clone.remove()
      anim.onfinish = remove
      anim.oncancel = remove
      // Belt and braces: never leave a clone behind (e.g. animations paused in a background tab).
      window.setTimeout(remove, (o.delay ?? 0) + o.duration + 1000)
    }
  }, [ref])
}
