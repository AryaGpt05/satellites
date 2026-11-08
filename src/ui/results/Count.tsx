/**
 * <Count>: a tabular number that behaves like an instrument settling, never like a slot machine.
 *
 *  - First display of `countKey` this session: counts up from 0 (ease-out, 700 ms). Already seen
 *    (back from a pass, a remount): shows the final value at once.
 *  - A later change of `value` (the final report replacing the partial one): the digits roll
 *    (old up and out, new up and in, 240 ms) and flash the signal colour once (600 ms), up or down.
 *  - Reduced motion: no count, no roll; a change fades in over 200 ms.
 *
 * Every frame writes textContent through refs; React renders this once. Local adapter for the
 * shell's planned Num `countKey` / `tick` props (S7).
 */
import { useLayoutEffect, useRef } from 'react'
import { DUR, EASE, easeOut } from '@/lib/ease'
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
      const start = performance.now() + delay
      const step = (now: number) => {
        const t = Math.min(1, Math.max(0, (now - start) / duration))
        cur.textContent = f(Math.round(value * easeOut(t)))
        if (t < 1) raf.current = requestAnimationFrame(step)
      }
      raf.current = requestAnimationFrame(step)
      return
    }

    if (prev === value) {
      cur.textContent = f(value)
      return
    }
    shown.current = value
    cur.textContent = f(value)
    if (!tick) return
    if (reduced) {
      cur.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear' })
      return
    }
    // Roll: the old digits leave upward, the new ones arrive from below.
    old.textContent = f(prev)
    root.classList.add(s.rolling)
    const dir = value > prev ? 1 : -1
    const opts = { duration: DUR.sm, easing: EASE.out, fill: 'both' as const }
    old.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-100 * dir}%)` }], opts)
    const a = cur.animate([{ transform: `translateY(${100 * dir}%)` }, { transform: 'translateY(0)' }], opts)
    a.onfinish = () => {
      root.classList.remove(s.rolling)
      old.textContent = ''
      a.cancel()
    }
    // One signal flash back to the resting colour.
    const rest = getComputedStyle(root).color
    const signal = getComputedStyle(document.documentElement).getPropertyValue('--signal').trim() || '#ff6a1a'
    root.animate([{ color: signal }, { color: rest }], { duration: 600, easing: 'linear' })
  }, [value, countKey, duration, delay, tick])

  useLayoutEffect(() => () => cancelAnimationFrame(raf.current), [])

  return (
    <span ref={rootRef} className={[s.count, className].filter(Boolean).join(' ')}>
      <span ref={oldRef} className={s.old} aria-hidden />
      <span ref={curRef} className={s.cur} />
    </span>
  )
}
