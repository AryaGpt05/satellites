/**
 * Time formatting for the results UI, always in the PLACE's time zone (not the viewer's).
 * Pure + cached Intl formatters, so it runs in tests and is cheap to call per row.
 *
 * Output is mixed case ("Sun 1 Nov"); mono labels uppercase it with CSS.
 */

const cache = new Map<string, Intl.DateTimeFormat>()

function dtf(locale: string, timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(opts)}`
  let f = cache.get(key)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...opts, timeZone })
    } catch {
      // Unknown zone (should not happen with tz-lookup output): fall back to UTC rather than throw in render.
      f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' })
    }
    cache.set(key, f)
  }
  return f
}

export interface LocalParts {
  year: number
  month: number // 1..12
  day: number
  weekday: string // "Sun"
  monthName: string // "Nov"
  hour: number
  minute: number
  second: number
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function localParts(ms: number, timeZone: string): LocalParts {
  const parts = dtf('en-GB', timeZone, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms)
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? ''
  const month = Number(get('month'))
  return {
    year: Number(get('year')),
    month,
    day: Number(get('day')),
    weekday: get('weekday').slice(0, 3),
    monthName: MONTHS[month - 1] ?? '',
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
  }
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "EST", "EDT", "CET"… or "UTC+9" where the locale has no abbreviation. */
export function zoneAbbr(ms: number, timeZone: string): string {
  const name = dtf('en-US', timeZone, { timeZoneName: 'short' })
    .formatToParts(ms)
    .find((p) => p.type === 'timeZoneName')?.value
  if (!name) return 'UTC'
  if (name === 'GMT' || name === 'UTC') return 'UTC'
  return name.replace(/^GMT(?=[+-])/, 'UTC')
}

/** "11:21" or "11:21:13" at the place. */
export function fmtLocalTime(ms: number, timeZone: string, seconds = false): string {
  const p = localParts(ms, timeZone)
  return `${pad2(p.hour)}:${pad2(p.minute)}${seconds ? `:${pad2(p.second)}` : ''}`
}

/** "Sun 1 Nov" at the place. */
export function fmtLocalDay(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone)
  return `${p.weekday} ${p.day} ${p.monthName}`
}

/** "Sun 1 Nov · 11:21 EST" */
export function fmtLocalStamp(ms: number, timeZone: string, seconds = false): string {
  return `${fmtLocalDay(ms, timeZone)} · ${fmtLocalTime(ms, timeZone, seconds)} ${zoneAbbr(ms, timeZone)}`
}

/** Local calendar date key "2026-11-01" (for day bucketing). */
export function localDateKey(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}

/** UTC offset at an instant, in minutes (EST → -300). */
export function utcOffsetMin(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000)
}

/**
 * "just now", "12 min ago", "5 h ago", "2 days ago" (and "in 3 h" for the future).
 * Hours up to 48 so "yesterday evening" reads as "30 h ago", which is what an instrument would say.
 */
export function fmtRelative(ms: number, now: number): string {
  const diff = now - ms
  const future = diff < 0
  const s = Math.abs(diff) / 1000
  let out: string
  if (s < 45) return 'just now'
  if (s < 3600) out = `${Math.max(1, Math.round(s / 60))} min`
  else if (s < 48 * 3600) out = `${Math.round(s / 3600)} h`
  else {
    const d = Math.round(s / 86_400)
    out = `${d} ${d === 1 ? 'day' : 'days'}`
  }
  return future ? `in ${out}` : `${out} ago`
}

/** "T−00:42" / "T+01:05" relative to a reference instant (mm:ss, or h:mm:ss past an hour). */
export function fmtTMinus(ms: number, ref: number): string {
  const d = Math.round((ms - ref) / 1000)
  const sign = d < 0 ? '−' : '+'
  const a = Math.abs(d)
  const h = Math.floor(a / 3600)
  const m = Math.floor((a % 3600) / 60)
  const s = a % 60
  return `T${sign}${h ? `${h}:${pad2(m)}` : pad2(m)}:${pad2(s)}`
}

/** "38 s", "4 min 12 s", "1 h 02 min" */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${pad2(s % 60)} s`
  return `${Math.floor(m / 60)} h ${pad2(m % 60)} min`
}
