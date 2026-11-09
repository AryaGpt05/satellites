/**
 * The Watched wordmark: "Watched." set in a serif with the full stop in signal orange (docs/brand).
 * The letters take `currentColor` (bone on ink by default); the dot is always var(--signal).
 * Size it by height; the width follows the aspect ratio. The bottom edge is the baseline.
 */
import type { CSSProperties } from 'react'
import { WORDMARK_ASPECT, WORDMARK_BOX, WORDMARK_DOT, WORDMARK_PATH } from '../../../api/_lib/wordmark'

export { WORDMARK_ASPECT }

export function Wordmark({ height = 18, className, style, title = 'Watched' }: { height?: number; className?: string; style?: CSSProperties; title?: string }) {
  return (
    <svg
      viewBox={WORDMARK_BOX.join(' ')}
      height={height}
      width={Math.round(height * WORDMARK_ASPECT * 100) / 100}
      className={className}
      style={style}
      role="img"
      aria-label={title}
      focusable="false"
    >
      <path d={WORDMARK_PATH} fill="currentColor" />
      <circle cx={WORDMARK_DOT.cx} cy={WORDMARK_DOT.cy} r={WORDMARK_DOT.r} fill="var(--signal, #FF6A1A)" />
    </svg>
  )
}
