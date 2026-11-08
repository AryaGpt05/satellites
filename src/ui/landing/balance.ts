/**
 * Keeping the hero still while notes come and go under the search field (see Landing's useBalance).
 *
 * The desktop column centres its content, so content that grows by g moves everything up by g / 2.
 * Padding the top of the column by g cancels that exactly; padding the bottom by −g cancels a shrink.
 * Growth is only absorbed as far as the free space allows, so the content never overflows the column.
 */

/**
 * @param columnH  the column's height (px)
 * @param contentH the content's height now, note included (px)
 * @param baseH    the content's height the last time no note was shown, or null if never measured
 * @param noteH    the note's height now (px); 0 means no note
 * @returns        > 0: pad the top by this; < 0: pad the bottom by its magnitude; 0: no padding
 */
export function balancePad(columnH: number, contentH: number, baseH: number | null, noteH: number): number {
  if (noteH <= 0) return 0
  const growth = contentH - (baseH ?? contentH - noteH)
  const free = columnH - contentH
  return Math.round(growth > 0 ? Math.min(growth, Math.max(0, free)) : growth)
}
