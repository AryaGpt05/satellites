import type { SatCategory } from '@/types'

/**
 * Stable small integers per category, written into the GPU element buffer (slot [10]).
 * Never renumber: the globe shader branches on these values.
 */
export const CATEGORY_INDEX: Record<SatCategory, number> = {
  other: 0,
  'open-optical': 1,
  'commercial-optical': 2,
  radar: 3,
  'weather-leo': 4,
  'weather-geo': 5,
  crewed: 6,
}

/** Categories for which we predict individual passes (weather-geo is continuous, 'other' is ambient). */
export const PASS_CATEGORIES = ['open-optical', 'commercial-optical', 'radar', 'weather-leo', 'crewed'] as const
export type PassCategory = (typeof PASS_CATEGORIES)[number]

export function isPassCategory(c: SatCategory): c is PassCategory {
  return (PASS_CATEGORIES as readonly string[]).includes(c)
}
