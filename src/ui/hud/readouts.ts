/**
 * Pure formatters for the corner readouts. Fixed-width where a value ticks, so right-aligned
 * readouts don't jitter: latitudes are zero-padded to 2 integer digits, longitudes to 3.
 */
import { gmst, RAD } from '@/lib/geo'
import { fmtInt } from '@/ui/system/format'

const pad = (n: number, w: number) => String(Math.trunc(n)).padStart(w, '0')

/** "06.2°S" — latitude with a fixed 2-digit integer part. */
export function fmtLatFixed(lat: number, digits = 1): string {
  const a = Math.abs(lat)
  const [i, f] = a.toFixed(digits).split('.')
  return `${i.padStart(2, '0')}${f ? '.' + f : ''}°${lat >= 0 ? 'N' : 'S'}`
}

/** "118.2°E" / "008.0°W" — longitude normalised to ±180 with a fixed 3-digit integer part. */
export function fmtLonFixed(lon: number, digits = 1): string {
  let l = ((((lon + 180) % 360) + 360) % 360) - 180
  // toFixed can round 179.96 up to "180.0"; keep the hemisphere consistent with the printed value.
  if (Number(Math.abs(l).toFixed(digits)) >= 180) l = 180
  const [i, f] = Math.abs(l).toFixed(digits).split('.')
  const hemi = l === 180 || l === -180 ? 'E' : l >= 0 ? 'E' : 'W'
  return `${i.padStart(3, '0')}${f ? '.' + f : ''}°${hemi}`
}

/** "SUN 06.2°S 118.2°E" */
export function fmtSun(p: { lat: number; lon: number }, digits = 1): string {
  return `SUN ${fmtLatFixed(p.lat, digits)} ${fmtLonFixed(p.lon, digits)}`
}

/** Greenwich mean sidereal time as "HH:MM:SS" (sidereal hours). */
export function fmtGmst(ms: number): string {
  const hours = ((gmst(ms) * RAD) / 15 + 24) % 24
  const total = Math.floor(hours * 3600)
  return `${pad(total / 3600, 2)}:${pad((total % 3600) / 60, 2)}:${pad(total % 60, 2)}`
}

/** "2026-11-08 03:34Z" from an ISO string; "—" if unparseable. */
export function fmtStampZ(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}Z`
}

/** Compact age: "<1 MIN", "42 MIN", "5 H", "3 D". Never negative. */
export function fmtAge(fromMs: number, nowMs: number): string {
  const s = Math.max(0, (nowMs - fromMs) / 1000)
  if (s < 60) return '<1 MIN'
  if (s < 90) return '1 MIN'
  const m = Math.round(s / 60)
  if (m < 90) return `${m} MIN`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} H`
  return `${Math.round(h / 24)} D`
}

/** Element sets older than this are flagged (--warn): pass times drift by seconds per day. */
export const STALE_AFTER_MS = 48 * 3_600_000

export function isStale(fetchedAtIso: string, nowMs: number): boolean {
  const t = Date.parse(fetchedAtIso)
  return Number.isFinite(t) && nowMs - t > STALE_AFTER_MS
}

/** "16,893 OBJECTS" */
export const fmtObjects = (n: number) => `${fmtInt(n)} OBJECTS`

/** Catalog source label, e.g. "CelesTrak GP" → "CELESTRAK GP"; trims parentheticals for the corner. */
export function fmtSource(source: string): string {
  return source.replace(/\s*\(.*\)\s*$/, '').trim().toUpperCase() || 'CATALOG'
}
