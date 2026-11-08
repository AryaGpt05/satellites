/**
 * <Swap k dir>: animated content swap. When `k` changes, the old content leaves as a frozen clone laid
 * over the new one (opacity 1→0, translateX 0→−12px·dir, 160 ms ease-in-out) while the new content
 * enters (opacity 0→1, translateX 12px·dir→0, 240 ms ease-out, 80 ms delay). Reduced motion: a 160 ms
 * crossfade with no travel.
 *
 *   <Swap k={selectedId ?? 'overview'} dir={selectedId ? 1 : -1} onBeforeEnter={restoreScroll}>…</Swap>
 *
 * `onBeforeEnter` runs after the new content is in the DOM and before it becomes visible (e.g. restore
 * a scroll position so it never shows at the wrong place). The first mount does not animate.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { DUR, EASE } from '@/lib/ease'
import { animateOut, insertFrozenClone } from './exit'
import { prefersReducedMotion } from './motion'

/** Unmounts sooner than this after mounting are not animated (StrictMode's simulated unmount). */
const MIN_LIFETIME_MS = 48
const TRAVEL_PX = 12
const OUT_MS = 160
const IN_DELAY_MS = 80

export function Swap({
  k,
  dir = 1,
  children,
  className,
  onBeforeEnter,
}: {
  k: string
  /** +1: forward (content moves left), −1: back */
  dir?: number
  children: ReactNode
  className?: string
  onBeforeEnter?: () => void
}) {
  // The first item of this Swap mounts without an entrance.
  const mounted = useRef(false)
  const first = !mounted.current
  useLayoutEffect(() => {
    mounted.current = true
  }, [])
  return (
    <SwapItem key={k} dir={dir} enter={!first} className={className} onBeforeEnter={onBeforeEnter}>
      {children}
    </SwapItem>
  )
}

function SwapItem({
  dir,
  enter,
  className,
  onBeforeEnter,
  children,
}: {
  dir: number
  enter: boolean
  className?: string
  onBeforeEnter?: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const dirRef = useRef(dir)
  dirRef.current = dir
  const beforeEnter = useRef(onBeforeEnter)
  beforeEnter.current = onBeforeEnter

  useLayoutEffect(() => {
    const node = ref.current
    const mountedAt = performance.now()
    if (node && enter) {
      try {
        beforeEnter.current?.()
      } catch {
        /* cosmetic */
      }
      const reduced = prefersReducedMotion()
      const d = dirRef.current
      node.animate(
        reduced
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, transform: `translateX(${TRAVEL_PX * d}px)` },
              { opacity: 1, transform: 'translateX(0)' },
            ],
        { duration: reduced ? 160 : DUR.sm, delay: reduced ? 0 : IN_DELAY_MS, easing: EASE.out, fill: 'backwards' },
      )
    }
    return () => {
      // Leaving: still laid out here (layout cleanups run before React removes the node).
      if (!node || !node.isConnected || typeof node.animate !== 'function') return
      if (performance.now() - mountedAt < MIN_LIFETIME_MS) return
      const top = node.offsetTop
      const left = node.offsetLeft
      const width = node.offsetWidth
      const clone = insertFrozenClone(node, (c) => {
        c.style.position = 'absolute'
        c.style.top = `${top}px`
        c.style.left = `${left}px`
        c.style.width = `${width}px`
        c.style.margin = '0'
        c.style.zIndex = '1'
      })
      const reduced = prefersReducedMotion()
      const d = dirRef.current
      animateOut(
        clone,
        reduced
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { opacity: 1, transform: 'translateX(0)' },
              { opacity: 0, transform: `translateX(${-TRAVEL_PX * d}px)` },
            ],
        { duration: OUT_MS, easing: EASE.inOut },
      )
    }
    // The item's identity is its key; enter is fixed for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
