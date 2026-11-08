/** The report window as a mono kicker: "01 NOV → 08 NOV 2026 UTC" (or across years: "29 DEC 2026 → 05 JAN 2027 UTC"). */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

export const WINDOW_DAYS = 7

function day(ms: number, withYear: boolean): string {
  const d = new Date(ms)
  const s = `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`
  return withYear ? `${s} ${d.getUTCFullYear()}` : s
}

export function windowLabel(nowMs: number, days = WINDOW_DAYS): string {
  const start = nowMs - days * 86_400_000
  const crossesYear = new Date(start).getUTCFullYear() !== new Date(nowMs).getUTCFullYear()
  return `${day(start, crossesYear)} → ${day(nowMs, true)} UTC`
}
