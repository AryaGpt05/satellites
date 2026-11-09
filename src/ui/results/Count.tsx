/**
 * <Count>: a tabular number that behaves like an instrument settling, never like a slot machine.
 *
 *  - First display of `countKey` this session: counts up from 0 (ease-out, 700 ms). Already seen
 *    (back from a pass, a remount): shows the final value at once.
 *  - A later change of `value` (the final report replacing the partial one): the digits change IN PLACE
 *    with a 200 ms crossfade of the number only (owner A1: no roll, no colour flash, never the panel).
 *  - Reduced motion: no count; a change is the same 200 ms crossfade.
 *
 * Every frame writes textContent through refs; React renders this once. While it counts up, a hidden copy of the
 * final value holds the box at its final width (U-2), so the unit or words beside it never move. Local adapter for the
 * shell's planned Num `countKey` / `tick` props (S7).
 */
import { useLayoutEffect, useRef } from 'react'
import { DUR, easeOut } from '@/lib/ease'
import { prefersReducedMotion } from '@/ui/system'
import { int } from './lib/copy'
import { markSeen, wasSeen } from './once'
import s from './Count.module.css'

interface Props {
  value: number
  /** Count up once per key (e.g. `${windowEnd}:imaged`); omit to never count (static) */
  countKey?: string
  duration?: number
  delay?: number
  /** Roll + flash when the value changes after first display (default true) */
  tick?: boolean
  format?: (n: number) => string
  className?: string
}

export function Count({ value, countKey, duration = DUR.count, delay = 0, tick = true, format = int, className }: Props) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const curRef = useRef<HTMLSpanElement>(null)
  const oldRef = useRef<HTMLSpanElement>(null)
  const ghostRef = useRef<HTMLSpanElement>(null)
  const shown = useRef<number | null>(null)
  const raf = useRef(0)
  const fmt = useRef(format)
  fmt.current = format

  useLayoutEffect(() => {
    const cur = curRef.current
    const old = oldRef.current
    const root = rootRef.current
    if (!cur || !old || !root) return
    const reduced = prefersReducedMotion()
    const f = fmt.current
    const prev = shown.current
    cancelAnimationFrame(raf.current)

    // First display.
    if (prev === null) {
      shown.current = value
      const count = !!countKey && !wasSeen(countKey) && !reduced && value > 0
      if (countKey) markSeen(countKey)
      if (!count) {
        cur.textContent = f(value)
        return
      }
      cur.textContent = f(0)
      const ghost = ghostRef.current
      if (ghost) ghost.textContent = f(value)
      const start = performance.now() + delay
      const step = (now: number) => {
        const t = Math.min(1, Math.max(0, (now - start) / duration))
        cur.textContent = f(Math.round(value * easeOut(t)))
        if (t < 1) raf.current = requestAnimationFrame(step)
        else if (ghost) ghost.textContent = ''
      }
      raf.current = requestAnimationFrame(step)
      return
    }

    if (ghostRef.current) ghostRef.current.textContent = ''
    if (prev === value) {
      cur.textContent = f(value)
      return
    }
    shown.current = value
    cur.textContent = f(value)
    if (!tick) return
    // Crossfade: the old digits fade out where they stood while the new ones fade in (compositor only).
    old.textContent = f(prev)
    const opts = { duration: 200, easing: 'linear', fill: 'both' as const }
    old.animate([{ opacity: 1 }, { opacity: 0 }], opts)
    const a = cur.animate([{ opacity: 0 }, { opacity: 1 }], opts)
    a.onfinish = () => {
      old.textContent = ''
      a.cancel()
    }
    void reduced
  }, [value, countKey, duration, delay, tick])

  useLayoutEffect(() => () => cancelAnimationFrame(raf.current), [])

  return (
    <span ref={rootRef} className={[s.count, className].filter(Boolean).join(' ')}>
      <span ref={oldRef} className={s.old} aria-hidden />
      <span ref={ghostRef} className={s.ghost} aria-hidden />
      <span ref={curRef} className={s.cur} />
    </span>
  )
}
