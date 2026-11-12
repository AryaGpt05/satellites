/**
 * One definition of "stacked" (phone-like) layout, shared by JS. CSS can't import these: stylesheets copy the
 * query text by hand (see docs/DESIGN.md §4).
 *   stacked = width ≤ 760px, or portrait up to 1100px wide (portrait tablets)
 */
export const STACKED_QUERY = '(max-width: 760px), (orientation: portrait) and (max-width: 1100px)'
export const WIDE_QUERY = '(min-width: 761px) and (orientation: landscape), (min-width: 1101px)'
export const SHORT_LANDSCAPE_QUERY = '(orientation: landscape) and (min-width: 540px) and (max-height: 540px)'
export const isStacked = (w: number, h: number) => w <= 760 || (h > w && w <= 1100)
