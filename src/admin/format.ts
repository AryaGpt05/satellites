/** Number and time formats for the admin page (UTC throughout, like the app's HUD clock). */

const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

export const fmtInt = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? '—' : INT.format(Math.round(n)))

export function fmtPct(f: number | null | undefined): string {
  if (f == null || !Number.isFinite(f)) return '—'
  const p = f * 100
  return `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`
}

export const fmtSec = (ms: number | null | undefined): string => (ms == null || !Number.isFinite(ms) ? '—' : (ms / 1000).toFixed(2))

const pad = (n: number) => String(n).padStart(2, '0')

/** "NOV 08 14:00" (hour buckets) / "NOV 08" (days); `short` drops the date on hour ticks except at midnight. */
export function fmtBucket(t: number, bucket: 'hour' | 'day', short = false): string {
  const d = new Date(t)
  const day = `${MON[d.getUTCMonth()]} ${pad(d.getUTCDate())}`
  if (bucket === 'day') return day
  const hh = `${pad(d.getUTCHours())}:00`
  if (short) return d.getUTCHours() === 0 ? day : hh
  return `${day} ${hh}`
}

export function fmtAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s} S AGO`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} MIN AGO`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} H AGO`
  return `${Math.round(h / 24)} D AGO`
}

export function fmtStamp(t: number): string {
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/** 1, 2, 2.5, 5 × 10^k at or above `v`. */
export function niceMax(v: number): number {
  if (v <= 1) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p
  return 10 * p
}

let regions: Intl.DisplayNames | null | undefined
export function countryName(cc: string | undefined): string {
  if (!cc) return '—'
  try {
    regions ??= new Intl.DisplayNames(['en'], { type: 'region' })
    return regions.of(cc.toUpperCase()) ?? cc.toUpperCase()
  } catch {
    return cc.toUpperCase()
  }
}

export const SOURCE_NAMES: Record<string, string> = {
  search: 'Typed search',
  example: 'Example chip',
  near_me: 'Near me',
  deep_link: 'Deep link',
  share_link: 'Share link',
  retry: 'Retry',
}

export const ACTION_NAMES: Record<string, string> = {
  copy_link: 'Copy link',
  x: 'Post to X',
  native: 'System share',
  save_png: 'Save PNG',
  copy_image: 'Copy image',
}

export const DEVICE_NAMES: Record<string, string> = { desktop: 'Desktop', phone: 'Phone', tablet: 'Tablet' }

export const VERDICT_NAMES: Record<string, string> = { imaged: 'Watched', likely: 'Likely watched', could: 'Could have pointed here', overhead: 'Passed overhead' }

/** The hourly maintenance cron job hasn't run for over 2 hours (or never has). */
export function maintBehind(s: { maintLastAt: number | null; generatedAt: number }): boolean {
  return s.maintLastAt == null || s.generatedAt - s.maintLastAt > 2 * 3600e3
}
