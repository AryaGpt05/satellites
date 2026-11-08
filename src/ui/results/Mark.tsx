/**
 * <Mark>: the system Glyph plus the marks results needs that the shell set doesn't have yet:
 *   'mosaic'          a filled 4px disc inside a 1px ring (an imaged weather satellite: a real but
 *                     coarse daily mosaic, drawn in bone; the signal diamond is reserved for detailed
 *                     captures, DESIGN §2)
 *   'chevron-left/right'  ‹ › for stepping through passes, so stepping never reads as the ← of "back"
 *   'expand'          corner arrows: open a photo large (owner B2)
 * Same 16×16 grid and 1px non-scaling strokes as Glyph. Integration request: add these to
 * src/ui/system/Glyph.tsx and drop this wrapper.
 */
import { Glyph } from '@/ui/system'
import type { MarkName } from './lib/meta'

export function Mark({ name, size = 16, color = 'currentColor', className }: { name: MarkName; size?: number; color?: string; className?: string }) {
  const stroke = { fill: 'none', stroke: color, strokeWidth: 1, vectorEffect: 'non-scaling-stroke' as const }
  let body: React.ReactNode
  switch (name) {
    case 'mosaic':
      body = (
        <>
          <circle cx="8" cy="8" r="4.5" {...stroke} />
          <circle cx="8" cy="8" r="2" fill={color} />
        </>
      )
      break
    case 'chevron-left':
      body = <path d="M10 3.5 5.5 8l4.5 4.5" {...stroke} />
      break
    case 'chevron-right':
      body = <path d="M6 3.5 10.5 8 6 12.5" {...stroke} />
      break
    case 'expand':
      // Corner arrows (owner B2): out to the top-right and the bottom-left corners.
      body = <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" {...stroke} />
      break
    default:
      return <Glyph name={name} size={size} color={color} className={className} />
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden>
      {body}
    </svg>
  )
}
