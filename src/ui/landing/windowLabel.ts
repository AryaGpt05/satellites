/**
 * The report window as a mono kicker, in the product's one date style: days without zero padding, the
 * month once when both ends share it, the year once.
 *   "1 → 8 NOV 2026 UTC" · "29 OCT → 5 NOV 2026 UTC" · "29 DEC 2026 → 5 JAN 2027 UTC"
 */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

export const WINDOW_DAYS = 7

export function windowLabel(nowMs: number, days = WINDOW_DAYS): string {
  const a = new Date(nowMs - days * 86_400_000)
  const b = new Date(nowMs)
  const end = `${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`
  const start =
    a.getUTCFullYear() !== b.getUTCFullYear()
      ? `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}`
      : a.getUTCMonth() !== b.getUTCMonth()
        ? `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]}`
        : `${a.getUTCDate()}`
  return `${start} → ${end} UTC`
}
