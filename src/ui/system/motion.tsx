/**
 * Motion primitives. All respect prefers-reduced-motion.
 *  - <Num>      count-up tabular number
 *  - <Scramble> brief glyph scramble for code-like strings (IDs, coordinates) — first appearance only
 *  - <Reveal>   line mask wipe for text blocks
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

export function Num({
  value,
  duration = 800,
  format = (n: number) => Math.round(n).toLocaleString('en-US'),
  delay = 0,
  className,
}: {
  value: number
  duration?: number
  format?: (n: number) => string
  delay?: number
  className?: string
}) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0))
  const from = useRef(0)
  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(value)
      return
    }
    let raf = 0
    const start = performance.now() + delay
    const a = from.current
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration))
      const v = a + (value - a) * easeOut(t)
      setShown(v)
      if (t < 1) raf = requestAnimationFrame(tick)
      else from.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration, delay])
  return (
    <span className={className} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {format(shown)}
    </span>
  )
}

const GLYPHS = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ/-.:°'
export function Scramble({ text, duration = 380, delay = 0, className }: { text: string; duration?: number; delay?: number; className?: string }) {
  const [out, setOut] = useState(() => (prefersReducedMotion() ? text : text.replace(/[^\s]/g, ' ')))
  useEffect(() => {
    if (prefersReducedMotion()) {
      setOut(text)
      return
    }
    let raf = 0
    const start = performance.now() + delay
    const tick = (now: number) => {
      const t = (now - start) / duration
      if (t < 0) {
        raf = requestAnimationFrame(tick)
        return
      }
      if (t >= 1) {
        setOut(text)
        return
      }
      const settled = Math.floor(t * text.length)
      let s = ''
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (i < settled || ch === ' ') s += ch
        else s += GLYPHS[(Math.random() * GLYPHS.length) | 0]
      }
      setOut(s)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [text, duration, delay])
  return (
    <span className={className} aria-label={text}>
      {out}
    </span>
  )
}

/** Mask-wipe reveal for a block. Children appear by clip-path from left→right (or bottom→top with `axis='y'`). */
export function Reveal({
  children,
  delay = 0,
  duration = 900,
  axis = 'y',
  className,
  as: As = 'div',
  style,
}: {
  children: ReactNode
  delay?: number
  duration?: number
  axis?: 'x' | 'y'
  className?: string
  as?: 'div' | 'span' | 'h1' | 'h2' | 'p'
  style?: CSSProperties
}) {
  const reduced = prefersReducedMotion()
  const [on, setOn] = useState(reduced)
  useEffect(() => {
    if (reduced) return
    const id = window.setTimeout(() => setOn(true), delay)
    return () => window.clearTimeout(id)
  }, [delay, reduced])
  const hidden = axis === 'y' ? 'inset(0 0 100% 0)' : 'inset(0 100% 0 0)'
  return (
    <As
      className={className}
      style={{
        ...style,
        clipPath: on ? 'inset(0 0 0 0)' : hidden,
        transform: on || axis === 'x' ? 'none' : 'translateY(0.25em)',
        transition: reduced
          ? 'opacity 200ms'
          : `clip-path ${duration}ms var(--ease-out), transform ${duration}ms var(--ease-out)`,
        display: As === 'span' ? 'inline-block' : undefined,
      }}
    >
      {children}
    </As>
  )
}
