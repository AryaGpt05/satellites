/**
 * The place reticle, drawn the same everywhere a photo shows "you" (R2R2): the pass view, the gallery cards and
 * the lightbox. viewBox -50 -50 100 100: an ink knock-out under the strokes (legible over any terrain), the
 * signal ring r = 15, four ticks, a centre dot. Lock-in: 1.6× → 1× over 500 ms ease-out when `locked` turns
 * true (reduced motion: no scale).
 */
import { cx } from '@/ui/system'
import s from './Reticle.module.css'

const TICKS = 'M0 -30V-20M0 20V30M-30 0H-20M20 0H30'

export function Reticle({ size, locked = true, className }: { size: number; locked?: boolean; className?: string }) {
  return (
    <svg className={cx(s.reticle, locked && s.locked, className)} width={size} height={size} viewBox="-50 -50 100 100" aria-hidden>
      <g className={s.knock}>
        <circle r="15" />
        <path d={TICKS} />
      </g>
      <circle r="15" className={s.ring} />
      <path d={TICKS} className={s.ring} />
      <circle r="1.6" className={s.dot} />
    </svg>
  )
}
