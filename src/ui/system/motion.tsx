/**
 * Motion primitives. All respect prefers-reduced-motion, and all use the one easing family in
 * src/lib/ease.ts (re-exported here so UI code imports motion from one place).
 *  - <Num>      tabular number: counts up once per key, then rolls + flashes when it changes
 *  - <Scramble> brief glyph scramble for code-like strings (IDs, coordinates)
 *  - <Reveal>   line mask wipe for text blocks
 *  - useOnce    "first appearance this session" (count once, reveal once)
 *
 * Per-frame work never goes through React: the rAF loops write textContent on the element they own
 * (which React leaves alone while the string it rendered is unchanged), and React renders only the
 * initial and final values.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { DUR, EASE, easeInOut, easeOut } from '@/lib/ease'
import { legDone, retarget, sampleLeg, type CountLeg } from './count'
import s from './motion.module.css'

export { DUR, EASE, easeInOut, easeOut }

let reducedMql: MediaQueryList | null | undefined
/** Live read of prefers-reduced-motion (one MediaQueryList, created on first use). */
export const prefersReducedMotion = (): boolean => {
  if (reducedMql === undefined) reducedMql = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  return !!reducedMql?.matches
}

// ── once ─────────────────────────────────────────────────────────────────────────────────

const seenKeys = new Set<string>()

/** Whether `key` has been shown before in this session (without marking it). */
export const wasSeen = (key: string) => seenKeys.has(key)
/** Mark a key as shown (e.g. when an imperative animation starts). */
export const markSeen = (key: string) => void seenKeys.add(key)

/**
 * True the first time `key` is shown in this session, false on every later mount. Decided once per
 * (mount, key), so StrictMode's double render and effect replay never flip it.
 */
export function useOnce(key: string): boolean {
  const ref = useRef<{ key: string; first: boolean } | null>(null)
  if (!ref.current || ref.current.key !== key) ref.current = { key, first: !seenKeys.has(key) }
  useEffect(() => {
    seenKeys.add(key)
  }, [key])
  return ref.current.first
}

// ── Num ──────────────────────────────────────────────────────────────────────────────────

const intFmt = (n: number) => Math.round(n).toLocaleString('en-US')

export interface NumProps {
  value: number
  /** Count-up length (ms). Default DUR.count (700). */
  duration?: number
  format?: (n: number) => string
  /** Delay before the first count starts (ms) */
  delay?: number
  /** Value the first count starts from. Default 0. */
  from?: number
  /** Count up only the first time this key is shown this session; later mounts show the value at once. */
  countKey?: string
  /**
   * A change after first display rolls the digits (old up and out, new up and in, 240 ms) and flashes
   * the signal colour once (600 ms), instead of counting from the shown value.
   */
  tick?: boolean
  className?: string
}

/**
 * Tabular number with a count-up (ease-out, DUR.count). Re-targeted mid-count, it continues from the
 * value on screen, never from where the last count began.
 */
export function Num({ value, duration = DUR.count, format = intFmt, delay = 0, from = 0, countKey, tick = false, className }: NumProps) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const curRef = useRef<HTMLSpanElement>(null)
  const oldRef = useRef<HTMLSpanElement>(null)
  const fmt = useRef(format)
  fmt.current = format
  // What React renders: the start value, then the final one once a count lands (≤ 2 renders per count).
  const [rendered, setRendered] = useState(() => {
    const instant = prefersReducedMotion() || (countKey !== undefined && seenKeys.has(countKey))
    return instant ? value : from
  })
  const leg = useRef<CountLeg | undefined>(undefined)
  const shown = useRef<number | null>(null)
  const raf = useRef(0)

  useLayoutEffect(() => {
    const cur = curRef.current
    if (!cur) return
    const reduced = prefersReducedMotion()
    const f = fmt.current
    const write = (n: number) => {
      cur.textContent = f(n)
    }
    const run = () => {
      cancelAnimationFrame(raf.current)
      const step = (now: number) => {
        raf.current = 0
        const l = leg.current
        if (!l) return
        const v = sampleLeg(l, now)
        shown.current = v
        write(v)
        if (!legDone(l, now)) raf.current = requestAnimationFrame(step)
        else {
          leg.current = undefined
          setRendered(l.to)
        }
      }
      raf.current = requestAnimationFrame(step)
    }

    // First display.
    if (shown.current === null) {
      const counted = countKey === undefined || !seenKeys.has(countKey)
      if (countKey !== undefined) seenKeys.add(countKey)
      if (reduced || !counted || value === from) {
        shown.current = value
        write(value)
        return
      }
      shown.current = from
      write(from)
      leg.current = retarget(undefined, value, performance.now(), duration, delay, from)
      run()
      return
    }

    const target = leg.current ? leg.current.to : shown.current
    if (target === value) {
      // Same target, but the count's frame loop was cancelled under it (StrictMode's simulated
      // unmount / remount keeps the refs): carry on from where it is rather than freeze there.
      if (leg.current && !raf.current) run()
      return
    }
    const now = performance.now()

    // Mid-count: carry on from what is on screen.
    if (leg.current && !reduced) {
      leg.current = retarget(leg.current, value, now, duration)
      run()
      return
    }

    const prev = shown.current
    if (reduced || !tick) {
      if (reduced) {
        cancelAnimationFrame(raf.current)
        leg.current = undefined
        shown.current = value
        write(value)
        setRendered(value)
        cur.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear' })
        return
      }
      leg.current = retarget(undefined, value, now, duration, 0, prev)
      run()
      return
    }

    // Tick: the digits roll, then one signal flash back to the resting colour.
    shown.current = value
    write(value)
    setRendered(value)
    const root = rootRef.current
    const old = oldRef.current
    if (!root || !old) return
    old.textContent = f(prev)
    root.dataset.rolling = 'true'
    const dir = value > prev ? 1 : -1
    const opts = { duration: DUR.sm, easing: EASE.out, fill: 'both' as const }
    old.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-100 * dir}%)` }], opts)
    const a = cur.animate([{ transform: `translateY(${100 * dir}%)` }, { transform: 'translateY(0)' }], opts)
    a.onfinish = () => {
      delete root.dataset.rolling
      old.textContent = ''
      a.cancel()
    }
    // Resolved once (a single style read per tick): keyframes need concrete colours.
    const rest = getComputedStyle(root).color
    const signal = getComputedStyle(document.documentElement).getPropertyValue('--signal').trim() || '#ff6a1a'
    root.animate([{ color: signal }, { color: rest }], { duration: 600, easing: 'linear' })
  }, [value, countKey, duration, delay, from, tick])

  useLayoutEffect(
    () => () => {
      cancelAnimationFrame(raf.current)
      raf.current = 0
    },
    [],
  )

  return (
    <span ref={rootRef} className={className ? `${s.num} ${className}` : s.num}>
      {tick ? <span ref={oldRef} className={s.old} aria-hidden /> : null}
      <span ref={curRef} className={s.cur}>
        {fmt.current(rendered)}
      </span>
    </span>
  )
}

// ── Scramble ─────────────────────────────────────────────────────────────────────────────

const GLYPHS = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ/-.:°'

/** One frame of a scramble: characters before the settle point are final, the rest are random glyphs. */
export function scrambleFrame(text: string, t: number): string {
  if (t >= 1) return text
  const settled = Math.floor(Math.max(0, t) * text.length)
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    out += i < settled || ch === ' ' ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0]
  }
  return out
}

/**
 * The string's footprint before the scramble starts: every glyph a no-break space, which (unlike a plain space) never
 * collapses, so the slot keeps its width and nothing after it moves (LAP-06: a collapsed coordinates slot pulled the
 * time zone 85–146 px left for a frame). The text's own spaces stay breakable.
 */
const blank = (text: string) => text.replace(/[^\s]/g, '\u00a0')

/**
 * Drive a scramble of `text` on `el` (textContent) and call `done` once it has settled. Returns a
 * cancel function. `live()` is read for the final write, so a value that changed meanwhile lands.
 */
function runScramble(el: HTMLElement, text: string, delay: number, duration: number, live: () => string, done: () => void): () => void {
  let raf = 0
  const start = performance.now() + delay
  el.textContent = blank(text)
  const tick = (now: number) => {
    const t = (now - start) / duration
    if (t < 0) {
      raf = requestAnimationFrame(tick)
      return
    }
    if (t >= 1) {
      el.textContent = live()
      done()
      return
    }
    el.textContent = scrambleFrame(text, t)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}

export function Scramble({ text, duration = 380, delay = 0, className }: { text: string; duration?: number; delay?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const textRef = useRef(text)
  textRef.current = text
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || prefersReducedMotion()) return
    return runScramble(el, text, delay, duration, () => textRef.current, () => undefined)
  }, [text, duration, delay])
  return (
    <span ref={ref} className={className} aria-label={text}>
      {text}
    </span>
  )
}

/**
 * Glyph-scramble a code-like string the first time it appears, then show it plainly from then on
 * (DESIGN §5: "only on first appearance"). Values that keep changing (clocks, coordinates) settle on
 * the live value as soon as the scramble ends. Empty / undefined means "not known yet": nothing
 * scrambles until it is.
 */
export function ScrambleOnce({ text, delay = 0, duration = 380, className }: { text?: string; delay?: number; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const live = useRef(text ?? '')
  live.current = text ?? ''
  const state = useRef<'pending' | 'running' | 'done'>(prefersReducedMotion() ? 'done' : 'pending')
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || state.current !== 'pending' || !text) return
    state.current = 'running'
    const cancel = runScramble(el, text, delay, duration, () => live.current, () => (state.current = 'done'))
    return () => {
      cancel()
      // Cancelled before it settled (StrictMode replay, unmount): start over next time, and never leave
      // a half-scrambled string behind.
      if (state.current === 'running') {
        state.current = 'pending'
        el.textContent = live.current
      }
    }
    // Only the first known value scrambles; later values are written by React directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!text])
  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  )
}

// ── Reveal ───────────────────────────────────────────────────────────────────────────────

/**
 * Mask-wipe reveal for a block. Children appear by clip-path from top→bottom (`axis='y'`, with a short rise) or
 * left→right (`axis='x'`). A CSS animation whose delay is set at mount (fill: backwards): the wipe runs on wall-clock
 * time from the frame the block first renders, so a busy main thread (the boot curtain's exit, texture uploads,
 * the landing's first render) can drop frames of it but never pushes its start back (PH-05: a timer and a
 * re-render started the landing's wipe up to a second late, after the loading screen's ink had gone). Once it has
 * played the clip is released entirely, so nothing that legitimately reaches past the box (focus rings, italic
 * overhangs, popovers) stays cut off.
 */
export function Reveal({
  children,
  delay = 0,
  duration = DUR.lg,
  axis = 'y',
  className,
  as: As = 'div',
  style,
  skip = false,
}: {
  children: ReactNode
  delay?: number
  duration?: number
  axis?: 'x' | 'y'
  className?: string
  as?: 'div' | 'span' | 'h1' | 'h2' | 'p'
  style?: CSSProperties
  /** Render settled at once (e.g. a return visit that already saw the entrance) */
  skip?: boolean
}) {
  // Decided once per mount: a reduced-motion change mid-entrance must not restart or cut it.
  const [animate] = useState(() => !skip && !prefersReducedMotion())
  const on = animate && !skip
  return (
    <As
      className={on ? (className ? `${className} ${axis === 'y' ? s.revealY : s.revealX}` : axis === 'y' ? s.revealY : s.revealX) : className}
      style={{
        ...style,
        ...(on ? ({ '--reveal-ms': `${duration}ms`, '--reveal-delay': `${delay}ms` } as CSSProperties) : null),
        display: As === 'span' ? 'inline-block' : style?.display,
      }}
    >
      {children}
    </As>
  )
}
