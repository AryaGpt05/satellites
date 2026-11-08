/** Formatting helpers — mono readouts. Keep output stable-width where possible. */
const pad = (n: number, w = 2) => String(Math.trunc(n)).padStart(w, '0')

export function fmtUtc(ms: number, withSeconds = true): string {
  const d = new Date(ms)
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${withSeconds ? ':' + pad(d.getUTCSeconds()) : ''}`
  return `${date} ${time}`
}
export function fmtUtcTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}
/** Local time at a longitude-ish place: we use the browser's Intl with an explicit tz if provided */
export function fmtLocal(ms: number, timeZone?: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
    ...opts,
  }).format(ms)
}
export function fmtDay(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone }).format(ms)
}
export function fmtLat(lat: number, digits = 4): string {
  return `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? 'N' : 'S'}`
}
export function fmtLon(lon: number, digits = 4): string {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180
  return `${Math.abs(l).toFixed(digits)}°${l >= 0 ? 'E' : 'W'}`
}
export function fmtInt(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n))
}
export function fmtNum(n: number, digits = 1): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
export function fmtNorad(n: number): string {
  return String(n).padStart(5, '0')
}
/** "3 min ago", "2 h ago", "4 days ago" */
export function fmtAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}
