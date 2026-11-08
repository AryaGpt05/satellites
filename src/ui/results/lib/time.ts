/**
 * Time formatting for the results UI, always in the PLACE's time zone (not the viewer's).
 * Pure + cached Intl formatters, so it runs in tests and is cheap to call per row.
 *
 * Output is mixed case ("Sun 1 Nov"); mono labels uppercase it with CSS. Human dates never zero-pad
 * the day and carry no year (share cards add it); machine stamps stay ISO.
 */

/**
 * One cached formatter per (call site, zone). Keys are fixed strings per call site, so a row render
 * never pays for JSON.stringify or a fresh Intl object.
 */
const cache = new Map<string, Intl.DateTimeFormat>()

function dtf(site: string, locale: string, timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${site}|${timeZone}`
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

const PARTS_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
}
const ZONE_OPTS: Intl.DateTimeFormatOptions = { timeZoneName: 'short' }

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
  const parts = dtf('parts', 'en-GB', timeZone, PARTS_OPTS).formatToParts(ms)
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
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Local fields at a known UTC offset (minutes), without Intl: the same values as localParts. */
export function partsAtOffset(ms: number, offsetMin: number): LocalParts {
  const d = new Date(ms + offsetMin * 60_000)
  const month = d.getUTCMonth() + 1
  return {
    year: d.getUTCFullYear(),
    month,
    day: d.getUTCDate(),
    weekday: WEEKDAYS_SHORT[d.getUTCDay()],
    monthName: MONTHS[month - 1],
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  }
}

/** Longest window `windowOffset` assumes holds at most one offset change. */
const ONE_CHANGE_MS = 40 * 86_400_000

/**
 * The zone's UTC offset across [t0, t1] as a cheap function, from a handful of Intl calls (PERF-03:
 * the timeline's 15-minute stepping made ~1,300 formatToParts calls per report). An offset is
 * piecewise constant and a window of a few weeks holds at most one change (DST), which is found by
 * bisection to the whole minute (transitions happen on whole minutes). Longer windows fall back to
 * asking Intl at every instant.
 */
export function windowOffset(t0: number, t1: number, timeZone: string): (ms: number) => number {
  if (t1 - t0 > ONE_CHANGE_MS) return (ms) => utcOffsetMin(ms, timeZone)
  const a = utcOffsetMin(t0, timeZone)
  const b = utcOffsetMin(t1, timeZone)
  if (a === b) return () => a
  // Minute indexes: offset(lo) = a, offset(hi) = b; narrow until hi is the first minute of `b`.
  let lo = Math.floor(t0 / 60_000)
  let hi = Math.ceil(t1 / 60_000)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (utcOffsetMin(mid * 60_000, timeZone) === a) lo = mid
    else hi = mid
  }
  const change = hi * 60_000
  return (ms) => (ms < change ? a : b)
}

/** "UTC+9", "UTC−3", "UTC+5:30" (true minus sign) for an offset in minutes. */
export function utcLabel(offsetMin: number): string {
  if (!offsetMin) return 'UTC'
  const a = Math.abs(offsetMin)
  const h = Math.floor(a / 60)
  const m = a % 60
  return `UTC${offsetMin < 0 ? '−' : '+'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`
}

/** Familiar fixed abbreviations (no daylight time) the en-US locale doesn't know. */
const FIXED_ABBR: Record<string, string> = {
  'Asia/Tokyo': 'JST',
  'Asia/Seoul': 'KST',
  'Asia/Kolkata': 'IST',
  'Asia/Calcutta': 'IST',
  'Asia/Hong_Kong': 'HKT',
  'Asia/Singapore': 'SGT',
  'Asia/Jakarta': 'WIB',
  'Europe/Moscow': 'MSK',
  'Australia/Perth': 'AWST',
}
/** [standard, daylight] pairs by zone family and standard offset (minutes). */
const EUROPE: Record<number, [string, string]> = { 0: ['WET', 'WEST'], 60: ['CET', 'CEST'], 120: ['EET', 'EEST'] }
const BRITISH = new Set(['Europe/London', 'Europe/Belfast', 'Europe/Guernsey', 'Europe/Isle_of_Man', 'Europe/Jersey'])
const AUSTRALIA: Record<number, [string, string]> = { 600: ['AEST', 'AEDT'], 570: ['ACST', 'ACDT'], 480: ['AWST', 'AWST'] }

const stdOffsetCache = new Map<string, number>()
/** The zone's standard (non-daylight) UTC offset in the year of `ms`: the smaller of January's and July's. */
function standardOffsetMin(ms: number, timeZone: string): number {
  const year = new Date(ms).getUTCFullYear()
  const key = `${timeZone}|${year}`
  let v = stdOffsetCache.get(key)
  if (v === undefined) {
    v = Math.min(utcOffsetMin(Date.UTC(year, 0, 1), timeZone), utcOffsetMin(Date.UTC(year, 6, 1), timeZone))
    stdOffsetCache.set(key, v)
  }
  return v
}

/**
 * "EST", "EDT", "JST", "CET", "AEDT"… or "UTC+9" where there is no familiar abbreviation.
 * The en-US locale only knows North American names, so Europe, Australia and the big Asian zones
 * are mapped by hand from the real offset at that instant (DST-correct).
 */
export function zoneAbbr(ms: number, timeZone: string): string {
  const fixed = FIXED_ABBR[timeZone]
  if (fixed) return fixed
  if (timeZone.startsWith('Europe/') || timeZone.startsWith('Australia/') || timeZone === 'Arctic/Longyearbyen') {
    const std = standardOffsetMin(ms, timeZone)
    const dst = utcOffsetMin(ms, timeZone) > std ? 1 : 0
    if (BRITISH.has(timeZone)) return dst ? 'BST' : 'GMT'
    if (timeZone === 'Europe/Dublin') return dst ? 'IST' : 'GMT'
    const pair = (timeZone.startsWith('Australia/') ? AUSTRALIA : EUROPE)[std]
    if (pair) return pair[dst]
    return utcLabel(utcOffsetMin(ms, timeZone))
  }
  const name = dtf('zone', 'en-US', timeZone, ZONE_OPTS)
    .formatToParts(ms)
    .find((p) => p.type === 'timeZoneName')?.value
  if (!name) return 'UTC'
  if (name === 'GMT' || name === 'UTC') return 'UTC'
  // "GMT+9" / "GMT-3" / "GMT+5:30": recompute from the offset so the sign is a true minus.
  if (/^GMT[+-]/.test(name)) return utcLabel(utcOffsetMin(ms, timeZone))
  return name
}

/**
 * The zone as a place label: "America/Toronto" → "America/Toronto" (spaces for underscores), but
 * the ocean's nautical zones ("Etc/GMT+9", whose sign is inverted) read "UTC−9 · at sea".
 */
export function zoneLabel(ms: number, timeZone: string): string {
  if (timeZone.startsWith('Etc/')) return `${utcLabel(utcOffsetMin(ms, timeZone))} · at sea`
  return timeZone.replace(/_/g, ' ')
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

const WEEKDAYS: Record<string, string> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "Friday 6 November" at the place, for screen readers. */
export function fmtSpokenDay(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone)
  return `${WEEKDAYS[p.weekday] ?? p.weekday} ${p.day} ${MONTHS_LONG[p.month - 1] ?? ''}`
}

/** "41 hours ago", "12 minutes ago", "3 days ago": fmtRelative spelled out for screen readers. */
export function spokenRelative(ms: number, now: number): string {
  return fmtRelative(ms, now)
    .replace(/(\d+) min\b/, (_, n) => `${n} ${n === '1' ? 'minute' : 'minutes'}`)
    .replace(/(\d+) h\b/, (_, n) => `${n} ${n === '1' ? 'hour' : 'hours'}`)
}

/** "29 Oct" at the place (no weekday, no zero pad). */
export function fmtDayMonth(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone)
  return `${p.day} ${p.monthName}`
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
