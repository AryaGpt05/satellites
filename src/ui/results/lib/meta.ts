/**
 * What the UI needs to know about a satellite. Resolved from the engine's catalog + profiles at
 * runtime (see ../sats.ts); kept as a plain interface here so the pure helpers stay testable.
 *
 * Also the ONE vocabulary table for verdicts (DESIGN §7): every word the product uses for a verdict
 * (summary readouts, lane labels, list groups, tooltips, About, share renderers) comes from
 * VERDICT_META. Never spell a verdict name anywhere else.
 */
import type { Pass, SatCategory, SatProfile } from '@/types'
import type { GlyphName } from '@/ui/system/Glyph'

export interface SatMeta {
  norad: number
  name: string
  operator?: string
  category: SatCategory
  profile?: SatProfile
}

export type MetaFn = (norad: number) => SatMeta

export type Verdict = Pass['verdict']
export const VERDICTS: readonly Verdict[] = ['imaged', 'likely', 'could', 'overhead']

export interface VerdictWords {
  /** Display name: group titles, readout labels, tooltips */
  title: string
  /** Lane label (mono caps) */
  short: string
  /** Count unit after a number ("31 passes"; every verdict counts passes, so the four tiles read alike) */
  unit: string
  /** One sentence for title= / aria-describedby / About */
  definition: string
  /** Prose verb ("Sentinel-2C watched Waterloo"; owner, latest: user-facing copy says watched, never photographed) */
  verb: string
}

/** The only definition of the verdict vocabulary. Mono labels uppercase these with CSS. */
export const VERDICT_META: Record<Verdict, VerdictWords> = {
  imaged: {
    title: 'Watched',
    short: 'Photo',
    unit: 'passes',
    definition: 'A real image of this place exists in a public archive.',
    verb: 'watched',
  },
  likely: {
    title: 'Likely watched',
    short: 'Likely',
    unit: 'passes',
    definition: 'A fixed camera’s swath covered this place. No picture of it is published.',
    verb: 'swept over',
  },
  could: {
    title: 'Could have pointed here',
    short: 'Could',
    unit: 'passes',
    definition: 'A steerable or private camera was in range. Its operator doesn’t say whether it looked.',
    verb: 'passed within view',
  },
  overhead: {
    title: 'Passed overhead',
    short: 'Overhead',
    unit: 'passes',
    definition: 'Crossed your sky. Stations and everything else.',
    verb: 'passed overhead',
  },
}

/** Count unit, singular-aware: "1 pass", "31 passes". */
export function verdictUnit(v: Verdict, n: number): string {
  const u = VERDICT_META[v].unit
  return n === 1 ? u.replace(/(image|pass)(e?s)$/, '$1') : u
}

/** Group titles in the pass list (derived; kept as a record for existing call sites). */
export const VERDICT_TITLE: Record<Verdict, string> = {
  imaged: VERDICT_META.imaged.title,
  likely: VERDICT_META.likely.title,
  could: VERDICT_META.could.title,
  overhead: VERDICT_META.overhead.title,
}

/** Short words for tags and lane labels (derived). */
export const VERDICT_TAG: Record<Verdict, string> = {
  imaged: VERDICT_META.imaged.short,
  likely: VERDICT_META.likely.short,
  could: VERDICT_META.could.short,
  overhead: VERDICT_META.overhead.short,
}

/** Mark names: the system glyphs plus 'mosaic' (drawn locally by ../Mark.tsx until the shell adds it). */
export type MarkName = GlyphName | 'mosaic' | 'chevron-left' | 'chevron-right' | 'expand'

/** Mark for a whole verdict group (summary readouts, lane labels). */
export const VERDICT_GLYPH: Record<Verdict, GlyphName> = {
  imaged: 'imaged',
  likely: 'likely',
  could: 'commercial',
  overhead: 'crewed',
}

/**
 * Mark for one pass: form by category (DESIGN §2). The filled signal diamond is reserved for a
 * DETAILED capture (Sentinel-2 / Landsat, ≤ 30 m): an imaged weather satellite only has a daily
 * mosaic, which gets the bone 'mosaic' mark (decision: signal only where an image of YOU exists).
 */
export function glyphForPass(verdict: Verdict, category: SatCategory): MarkName {
  if (verdict === 'imaged') return category === 'weather-leo' ? 'mosaic' : 'imaged'
  switch (category) {
    case 'open-optical':
      return 'likely'
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

/** CSS colour token for a pass mark: signal = a detailed image exists; ice = radar (DESIGN §2). */
export function markColorVar(verdict: Verdict, category: SatCategory): string {
  if (verdict === 'imaged') return category === 'weather-leo' ? 'var(--bone)' : 'var(--signal)'
  if (category === 'radar') return 'var(--ice)'
  return 'var(--bone)'
}
