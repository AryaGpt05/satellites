/**
 * useExitClone: an exit animation for components that the parent unmounts outright
 * (`{open && <Panel/>}`), without an AnimatePresence-style wrapper.
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
 * Scroll offsets, recorded as they happen by one passive capturing listener on the document (installed
 * when this module loads), so an exit never has to read them when it unmounts: a scrollTop read then
 * forces a style and layout pass in the middle of the event that unmounted the node (the submit's
 * keydown, a close). Only boxes that have scrolled are kept; disconnected ones are dropped as they are
 * met. A read inside a scroll event is cheap: the frame's layout is normally clean when it fires.
 */
const scrolled = new Map<Element, [number, number]>()
if (typeof document !== 'undefined') {
  document.addEventListener(
    'scroll',
    (e) => {
      const t = e.target
      if (t instanceof Element) scrolled.set(t, [t.scrollTop, t.scrollLeft])
    },
    { capture: true, passive: true },
  )
}

/**
 * The non-zero scroll offsets recorded inside `node` (itself included), as [index, top, left], where
 * index is the element's position in `node.querySelectorAll('*')` (−1 for `node`). No layout reads.
 */
export function recordedScrolls(node: Element): [number, number, number][] {
  const out: [number, number, number][] = []
  let all: NodeListOf<Element> | null = null
  for (const [el, [top, left]] of scrolled) {
    if (!el.isConnected) {
      scrolled.delete(el)
      continue
    }
    if (!top && !left) continue
    if (el === node) out.push([-1, top, left])
    else if (node.contains(el)) {
      all ??= node.querySelectorAll('*')
      const i = Array.prototype.indexOf.call(all, el)
      if (i >= 0) out.push([i, top, left])
    }
  }
  return out
}

/**
 * Clone `node` as an inert, frozen copy and insert it right after `node` (so it paints in the same
 * place in the stacking order). Scroll positions are carried over. Returns the clone.
 *
 * Nothing here makes the live tree or the copy lay out: the scroll offsets come from the record kept
 * as they happened (recordedScrolls), and only the non-zero ones are written to the clone. With
 * nothing scrolled, the clone is first laid out with the next frame, not inside the event that
 * unmounted it.
 */
export function insertFrozenClone<T extends HTMLElement>(node: T, prepare?: (clone: T) => void): T {
  const scrolls = recordedScrolls(node)
  const clone = node.cloneNode(true) as T
  clone.setAttribute('aria-hidden', 'true')
  clone.removeAttribute('role')
  clone.removeAttribute('aria-live')
  clone.removeAttribute('id')
  clone.inert = true
  clone.style.pointerEvents = 'none'
  clone.style.animation = 'none'
  // Same document order as the live tree's querySelectorAll('*'): `prepare` runs after this list is
  // taken, so the recorded indexes still match.
  const dst = clone.querySelectorAll<HTMLElement>('*')
  dst.forEach((el) => {
    el.style.animation = 'none'
    el.removeAttribute('id')
  })
  try {
    prepare?.(clone)
  } catch {
    /* a failed cosmetic patch must never break the unmount */
  }
  node.parentNode?.insertBefore(clone, node.nextSibling)
  for (const [i, top, left] of scrolls) {
    const el = i < 0 ? clone : dst[i]
    if (el) {
      el.scrollTop = top
      el.scrollLeft = left
    }
  }
  return clone
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
