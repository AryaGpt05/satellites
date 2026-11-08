/**
 * What the UI needs to know about a satellite. Resolved from the engine's catalog + profiles at
 * runtime (see ../sats.ts); kept as a plain interface here so the pure helpers stay testable.
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

/** Mark for a whole verdict group (summary readouts, lane labels). */
export const VERDICT_GLYPH: Record<Verdict, GlyphName> = {
  imaged: 'imaged',
  likely: 'likely',
  could: 'commercial',
  overhead: 'crewed',
}

/** Short verdict words for tags and lane labels. */
export const VERDICT_TAG: Record<Verdict, string> = {
  imaged: 'Photographed',
  likely: 'Likely',
  could: 'Could have',
  overhead: 'Overhead',
}

/** Group titles in the pass list. */
export const VERDICT_TITLE: Record<Verdict, string> = {
  imaged: 'Photographed',
  likely: 'Likely in view',
  could: 'Could have pointed here',
  overhead: 'Passed overhead',
}

/** Mark for one pass: form by category (DESIGN §2), filled signal diamond when an image exists. */
export function glyphForPass(verdict: Verdict, category: SatCategory): GlyphName {
  if (verdict === 'imaged') return 'imaged'
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

/** CSS colour token for a pass mark: signal = an image exists; ice = radar (DESIGN §2). */
export function markColorVar(verdict: Verdict, category: SatCategory): string {
  if (verdict === 'imaged') return 'var(--signal)'
  if (category === 'radar') return 'var(--ice)'
  return 'var(--bone)'
}
