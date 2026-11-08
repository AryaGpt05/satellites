import type { ReactNode } from 'react'
import { cx } from './primitives'
import s from './CornerReadout.module.css'

export type Corner = 'tl' | 'tr' | 'bl' | 'br'

/**
 * A fixed mono readout in one corner of the bezel (DESIGN §4). Lines stack; right corners align right.
 * The block ignores pointer events except for links and buttons inside it.
 */
export function CornerReadout({
  corner,
  children,
  className,
  label,
  live,
}: {
  corner: Corner
  children: ReactNode
  className?: string
  /** Accessible name for the region, e.g. "Catalog status" */
  label?: string
  /** aria-live politeness for readouts whose text changes meaningfully (not for ticking clocks) */
  live?: 'polite' | 'off'
}) {
  return (
    <div className={cx(s.corner, s[corner], className)} role={label ? 'group' : undefined} aria-label={label} aria-live={live}>
      {children}
    </div>
  )
}
