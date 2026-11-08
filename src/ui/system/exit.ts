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
 * resting style (a fresh node would otherwise replay its entrance), and scrolled boxes keep their
 * scroll position (cloneNode alone would reset them to the top). `onStart` runs once the clone is in
 * the document, for choreography inside it (e.g. clear the text before the curtain lifts).
 *
 * Components unmounted within a few frames of mounting (React StrictMode's simulated unmount in dev)
 * are not cloned.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'
import { DUR, EASE } from '@/lib/ease'
import { prefersReducedMotion } from './motion'

/** Unmounts sooner than this after mounting are not animated (StrictMode's simulated unmount). */
const MIN_LIFETIME_MS = 48

export interface ExitOptions<T extends HTMLElement> {
  keyframes: Keyframe[]
  /** Default DUR.exit (240 ms) */
  duration?: number
  /** Default EASE.inOut (exits ease in and out at about half the entrance) */
  easing?: string
  delay?: number
  /** Mutate the clone before it animates (fix up text, drop interactive bits). */
  prepare?: (clone: T) => void
  /** Called after the clone is inserted and its exit has started. */
  onStart?: (clone: T, reduced: boolean) => void
  /** Keyframes used under prefers-reduced-motion. Default: a 200 ms fade. */
  reducedKeyframes?: Keyframe[]
}

/**
 * Clone `node` as an inert, frozen copy and insert it right after `node` (so it paints in the same
 * place in the stacking order). Scroll positions are carried over. Returns the clone.
 */
export function insertFrozenClone<T extends HTMLElement>(node: T, prepare?: (clone: T) => void): T {
  const clone = node.cloneNode(true) as T
  clone.setAttribute('aria-hidden', 'true')
  clone.removeAttribute('role')
  clone.removeAttribute('aria-live')
  clone.removeAttribute('id')
  clone.inert = true
  clone.style.pointerEvents = 'none'
  clone.style.animation = 'none'
  clone.querySelectorAll<HTMLElement | SVGElement>('*').forEach((el) => {
    el.style.animation = 'none'
    el.removeAttribute('id')
  })
  try {
    prepare?.(clone)
  } catch {
    /* a failed cosmetic patch must never break the unmount */
  }
  node.parentNode?.insertBefore(clone, node.nextSibling)
  copyScroll(node, clone)
  return clone
}

/** Carry every non-zero scroll offset in `from`'s subtree over to the same element in `to`'s. */
function copyScroll(from: Element, to: Element) {
  if (from.scrollTop || from.scrollLeft) {
    to.scrollTop = from.scrollTop
    to.scrollLeft = from.scrollLeft
  }
  const a = from.querySelectorAll('*')
  const b = to.querySelectorAll('*')
  for (let i = 0; i < a.length && i < b.length; i++) {
    const el = a[i]
    if (el.scrollTop || el.scrollLeft) {
      b[i].scrollTop = el.scrollTop
      b[i].scrollLeft = el.scrollLeft
    }
  }
}

/** Animate a clone out and remove it when done (or after a safety timeout in a background tab). */
export function animateOut(clone: HTMLElement, keyframes: Keyframe[], timing: { duration: number; delay?: number; easing?: string }): Animation {
  const anim = clone.animate(keyframes, { duration: timing.duration, delay: timing.delay ?? 0, easing: timing.easing ?? EASE.inOut, fill: 'forwards' })
  const remove = () => clone.remove()
  anim.onfinish = remove
  anim.oncancel = remove
  // Belt and braces: never leave a clone behind (e.g. animations paused in a background tab).
  window.setTimeout(remove, (timing.delay ?? 0) + timing.duration + 1000)
  return anim
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
      const clone = insertFrozenClone(node, o.prepare)
      const reduced = prefersReducedMotion()
      animateOut(clone, reduced ? (o.reducedKeyframes ?? [{ opacity: 1 }, { opacity: 0 }]) : o.keyframes, {
        duration: reduced ? 200 : (o.duration ?? DUR.exit),
        delay: reduced ? 0 : (o.delay ?? 0),
        easing: o.easing ?? EASE.inOut,
      })
      try {
        o.onStart?.(clone, reduced)
      } catch {
        /* cosmetic */
      }
    }
  }, [ref])
}
