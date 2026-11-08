/**
 * Glyph-scramble a code-like string the first time it appears, then show it plainly from then on
 * (DESIGN §5: "only on first appearance"). Values that keep changing — clocks, coordinates — settle
 * on the live value as soon as the scramble ends. Respects reduced motion (via <Scramble>).
 */
import { useEffect, useState } from 'react'
import { Scramble, prefersReducedMotion } from './motion'

export function ScrambleOnce({
  text,
  delay = 0,
  duration = 380,
  className,
}: {
  /** The live value. Empty / undefined means "not known yet": nothing scrambles until it is. */
  text?: string
  delay?: number
  duration?: number
  className?: string
}) {
  const [first, setFirst] = useState<string | undefined>(() => (prefersReducedMotion() ? undefined : text || undefined))
  const [done, setDone] = useState(() => prefersReducedMotion())
  useEffect(() => {
    if (!done && first === undefined && text) setFirst(text)
  }, [text, first, done])
  useEffect(() => {
    if (done || first === undefined) return
    const id = window.setTimeout(() => setDone(true), delay + duration + 16)
    return () => window.clearTimeout(id)
  }, [first, done, delay, duration])
  if (done || first === undefined) return <span className={className}>{text}</span>
  return <Scramble text={first} delay={delay} duration={duration} className={className} />
}
