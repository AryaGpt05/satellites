/**
 * Custom 1px-stroke marks. The ONLY icon set in the product (see docs/DESIGN.md §1, §2).
 * Drawn on a 16×16 grid with crisp 0.5px offsets so 1px strokes land on pixels.
 */
import type { SatCategory } from '@/types'

export type GlyphName =
  | 'imaged' // ◆ filled diamond
  | 'likely' // ◇ outline diamond
  | 'commercial' // □
  | 'radar' // □ with centre dot
  | 'weather-leo' // ○
  | 'weather-geo' // ◎ ring with tick
  | 'crewed' // ✛
  | 'other' // ·
  | 'reticle'
  | 'arrow-right'
  | 'arrow-left'
  | 'arrow-up-right'
  | 'close'
  | 'locate'
  | 'play'
  | 'pause'
  | 'share'
  | 'download'
  | 'search'

interface Props {
  name: GlyphName
  size?: number
  color?: string
  className?: string
  title?: string
}

export function Glyph({ name, size = 16, color = 'currentColor', className, title }: Props) {
  const s = { stroke: color, strokeWidth: 1, fill: 'none', vectorEffect: 'non-scaling-stroke' as const }
  const f = { fill: color }
  let body: React.ReactNode
  switch (name) {
    case 'imaged':
      body = <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" {...f} />
      break
    case 'likely':
      body = <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" {...s} />
      break
    case 'commercial':
      body = <rect x="3.5" y="3.5" width="9" height="9" {...s} />
      break
    case 'radar':
      body = (
        <>
          <rect x="3.5" y="3.5" width="9" height="9" {...s} />
          <rect x="7" y="7" width="2" height="2" {...f} />
        </>
      )
      break
    case 'weather-leo':
      body = <circle cx="8" cy="8" r="4.5" {...s} />
      break
    case 'weather-geo':
      body = (
        <>
          <circle cx="8" cy="8" r="5" {...s} />
          <circle cx="8" cy="8" r="1.5" {...f} />
          <path d="M8 0.5V3" {...s} />
        </>
      )
      break
    case 'crewed':
      body = <path d="M8 2.5v11M2.5 8h11" {...s} />
      break
    case 'other':
      body = <circle cx="8" cy="8" r="1.25" {...f} />
      break
    case 'reticle':
      body = (
        <>
          <circle cx="8" cy="8" r="4.5" {...s} />
          <path d="M8 0.5v3M8 12.5v3M0.5 8h3M12.5 8h3" {...s} />
          <circle cx="8" cy="8" r="0.9" {...f} />
        </>
      )
      break
    case 'arrow-right':
      body = <path d="M2.5 8h11M9.5 4l4 4-4 4" {...s} />
      break
    case 'arrow-left':
      body = <path d="M13.5 8h-11M6.5 4l-4 4 4 4" {...s} />
      break
    case 'arrow-up-right':
      body = <path d="M4.5 11.5l7-7M5.5 4.5h6v6" {...s} />
      break
    case 'close':
      body = <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" {...s} />
      break
    case 'locate':
      body = (
        <>
          <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" {...s} />
          <rect x="5.5" y="5.5" width="5" height="5" {...s} />
        </>
      )
      break
    case 'play':
      body = <path d="M4.5 3v10l8.5-5z" {...f} />
      break
    case 'pause':
      body = (
        <>
          <rect x="4" y="3" width="2.5" height="10" {...f} />
          <rect x="9.5" y="3" width="2.5" height="10" {...f} />
        </>
      )
      break
    case 'share':
      body = <path d="M8 10.5V2.5M5 5.5l3-3 3 3M3.5 8.5v5h9v-5" {...s} />
      break
    case 'download':
      body = <path d="M8 2.5v8M5 7.5l3 3 3-3M3.5 13.5h9" {...s} />
      break
    case 'search':
      body = (
        <>
          <circle cx="7" cy="7" r="4.5" {...s} />
          <path d="M10.5 10.5l3.5 3.5" {...s} />
        </>
      )
      break
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      shapeRendering="geometricPrecision"
    >
      {title ? <title>{title}</title> : null}
      {body}
    </svg>
  )
}

export function glyphForCategory(c: SatCategory, imaged = false): GlyphName {
  switch (c) {
    case 'open-optical':
      return imaged ? 'imaged' : 'likely'
    case 'commercial-optical':
      return 'commercial'
    case 'radar':
      return 'radar'
    case 'weather-leo':
      return 'weather-leo'
    case 'weather-geo':
      return 'weather-geo'
    case 'crewed':
      return 'crewed'
    default:
      return 'other'
  }
}
