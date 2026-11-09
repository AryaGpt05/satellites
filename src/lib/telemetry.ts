/**
 * In-app event telemetry: a small queue that batches events and sends them to the same-origin relay
 * (`/api/e`, which forwards them to the `log_events` RPC with the visitor's country from Vercel's edge).
 *
 * Privacy (README, About page):
 *  - No cookies, nothing persistent: the session id is random per TAB, in sessionStorage.
 *  - Never coordinates: a search is a city-level label ("Waterloo, Ontario, Canada") and its 0.1° (~10 km) cell.
 *  - Never an IP (the relay reads only Vercel's derived country header), never a full referrer (host only).
 *  - Error messages lose URLs and decimal numbers before they leave the browser (the server masks them again).
 *
 * Off (nothing is queued or sent) under automation (`navigator.webdriver`), on dev builds and local hosts, and
 * with `?noanalytics=1`. `track()` is safe to call from anywhere, any time: it never throws.
 *
 * The module has no side effects at import, and no imports: the share sheet (results chunk) and the lazy
 * src/app/telemetry.ts both use it, and an import of an app module from here would make Rolldown re-split the
 * boot chunks. `startTelemetry()` (src/app/telemetry.ts, loaded after first paint) hooks page-hide flushing.
 */
import type { Place } from '@/types'

export type EventType =
  | 'view'
  | 'search'
  | 'results'
  | 'results_final'
  | 'pass_open'
  | 'lightbox_open'
  | 'about_open'
  | 'share_open'
  | 'share_action'
  | 'error'
  | 'vitals'

export type ShareAction = 'x' | 'copy_link' | 'copy_image' | 'save_png' | 'native'
export type Props = Record<string, string | number | boolean | undefined>

interface Queued {
  type: EventType
  t: number
  p: Props
}

export interface TelemetryEnv {
  webdriver?: boolean
  dev?: boolean
  hostname?: string
  search?: string
  /** Build-time VITE_TELEMETRY_E2E=1 (end-to-end checks of a local build only; never set on Vercel): ignore webdriver + host. */
  e2e?: boolean
}

// ── Opt-outs ────────────────────────────────────────────────────────────────────────────────

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|0\.0\.0\.0|.*\.local|.*\.localhost)$/i

/** False for bots, dev builds, local hosts, and `?noanalytics=1`. */
export function telemetryAllowed(env: TelemetryEnv = currentEnv()): boolean {
  if (env.dev) return false
  if (/[?&]noanalytics=1(?:&|$)/.test(env.search ?? '')) return false
  if (env.e2e) return true
  if (env.webdriver) return false
  if (!env.hostname || LOCAL_HOST.test(env.hostname)) return false
  return true
}

function currentEnv(): TelemetryEnv {
  if (typeof window === 'undefined') return { webdriver: true }
  return {
    webdriver: typeof navigator !== 'undefined' && navigator.webdriver === true,
    dev: !!import.meta.env?.DEV,
    hostname: location.hostname,
    search: location.search,
    e2e: import.meta.env?.VITE_TELEMETRY_E2E === '1',
  }
}

// ── Coarsening (exported for tests) ─────────────────────────────────────────────────────────

const round1 = (n: number) => {
  const r = Math.round(n * 10) / 10
  return r === 0 ? 0 : r // no -0
}

/** The 0.1° (~10 km) grid cell id, in record_lookup's format: '43.5,-80.5'. */
export function cellOf(lat: number, lon: number): string | undefined {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined
  let lo = round1(lon)
  if (lo === -180) lo = 180
  return `${round1(lat).toFixed(1)},${lo.toFixed(1)}`
}

/**
 * Street-like names ("King Street North", "Rue de Rivoli"): treated like an address, i.e. replaced by the city.
 * English street words only after the first word, so "St. Louis" and "Avenue Road" style places at the start stay.
 */
const STREET_SUFFIX = /\s(street|st|road|rd|avenue|ave|drive|dr|lane|ln|boulevard|blvd|way|crescent|cres|terrace|highway|hwy|parkway|pkwy|strasse|straße|gasse|weg)\b\.?/i
const STREET_PREFIX = /^(rue|calle|via|viale|avenida|av\.|chemin|rua|carrer|ulica|ul\.)\s/i
const streetish = (s: string) => STREET_SUFFIX.test(s) || STREET_PREFIX.test(s) || /straße$|strasse$|gasse$/i.test(s)

/**
 * City / region level: "Waterloo, Ontario, Canada". A typed street address (or a street, or a
 * near-me reverse geocode) is saved as its city (`cityLevel` is src/lib/backend.ts `cityLevelLabel`,
 * passed in), followed by the region parts of the sublabel. Parts with digits (postcodes, house
 * numbers, coordinates) are dropped.
 */
export function regionLabel(
  place: Pick<Place, 'label' | 'sublabel' | 'source'>,
  cityLevel: (p: Pick<Place, 'label' | 'sublabel'>) => string | undefined,
): string | undefined {
  const parts = (place.sublabel ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/\d/.test(s))
  const specific = place.source === 'geolocation' || streetish(place.label ?? '')
  const city = specific ? parts[0] : cityLevel(place)
  if (!city) return parts.length ? clip(parts.join(', '), 120) : undefined
  const rest = parts.filter((p) => p.toLowerCase() !== city.toLowerCase())
  return clip([city, ...rest].join(', '), 120)
}

/** phone / tablet / desktop from the viewport and the primary pointer. */
export function deviceClass(w: number, h: number, coarse: boolean): 'phone' | 'tablet' | 'desktop' {
  const short = Math.min(w, h)
  if (coarse) return short < 600 ? 'phone' : 'tablet'
  return short < 500 ? 'phone' : 'desktop'
}

/** The referrer's host, or undefined for none / our own site. */
export function referrerHost(referrer: string, ownHost: string): string | undefined {
  try {
    if (!referrer) return undefined
    const h = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '')
    if (!h || h === ownHost.toLowerCase().replace(/^www\./, '')) return undefined
    return /^[a-z0-9.-]{1,100}$/.test(h) ? h : undefined
  } catch {
    return undefined
  }
}

/** utm_source / utm_medium / utm_campaign, clipped. */
export function utmOf(search: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const q = new URLSearchParams(search)
    for (const [k, max] of [['utm_source', 40], ['utm_medium', 40], ['utm_campaign', 60]] as const) {
      const v = q.get(k)?.trim()
      if (v) out[k] = clip(v, max)
    }
  } catch {
    /* no utm */
  }
  return out
}

/** URLs and decimal numbers (which could be coordinates) masked, whitespace collapsed, 200 chars. */
export function scrubMessage(msg: unknown): string | undefined {
  if (msg == null) return undefined
  const s = String(msg)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/-?\d+\.\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
  return s ? clip(s, 200) : undefined
}

function clip(s: string, max: number): string {
  const cps = Array.from(s)
  return cps.length > max ? cps.slice(0, max).join('') : s
}

// ── Session ─────────────────────────────────────────────────────────────────────────────────

const SID_KEY = 'watched.sid'
let sid: string | undefined

function randomId(): string {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  return Array.from(a, (b) => abc[b & 63]).join('') + Array.from(a.slice(0, 6), (b) => abc[b >> 2]).join('')
}

/** Random per tab (sessionStorage), never persisted across visits. */
export function sessionId(): string {
  if (sid) return sid
  try {
    const have = sessionStorage.getItem(SID_KEY)
    if (have && /^[A-Za-z0-9_-]{16,32}$/.test(have)) return (sid = have)
    sid = randomId()
    sessionStorage.setItem(SID_KEY, sid)
  } catch {
    sid ??= randomId()
  }
  return sid
}

// ── Queue ───────────────────────────────────────────────────────────────────────────────────

export const ENDPOINT = '/api/e'
const MAX_BATCH = 50
const FLUSH_MS = 4000
const MAX_QUEUE = 200
/** Share sheet fallbacks (copy image → save, native → copy) would count one press twice. */
const SHARE_DEDUPE_MS = 1500

type Sender = (body: string, beacon: boolean) => void
type Enricher = (type: EventType, p: Props) => Props

let allowed: boolean | undefined
let queue: Queued[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let lastShareAt = -Infinity
let enricher: Enricher | undefined
let sender: Sender = defaultSender
let ctxCache: Record<string, string> | undefined

function isAllowed(): boolean {
  if (allowed === undefined) {
    try {
      allowed = telemetryAllowed()
    } catch {
      allowed = false
    }
  }
  return allowed
}

/** Queue one event. No-op when telemetry is off. Never throws. */
export function track(type: EventType, p: Props = {}): void {
  try {
    if (!isAllowed()) return
    const now = Date.now()
    if (type === 'share_action') {
      if (now - lastShareAt < SHARE_DEDUPE_MS) return
      lastShareAt = now
    }
    const props = enricher ? enricher(type, p) : p
    const clean: Props = {}
    for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== '' && !(typeof v === 'number' && !Number.isFinite(v))) clean[k] = v
    if (queue.length >= MAX_QUEUE) return
    queue.push({ type, t: now, p: clean })
    if (queue.length >= 20) flush(false)
    else timer ??= setTimeout(() => flush(false), FLUSH_MS)
  } catch {
    /* telemetry never breaks the app */
  }
}

/** Add derived fields (a satellite's name from its NORAD id) before an event is queued. */
export function setEnricher(fn: Enricher | undefined): void {
  enricher = fn
}

function context(): Record<string, string> {
  if (ctxCache) return ctxCache
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const ctx: Record<string, string> = {
    device: deviceClass(innerWidth, innerHeight, coarse),
    ...utmOf(location.search),
  }
  const ref = referrerHost(document.referrer, location.hostname)
  if (ref) ctx.ref = ref
  const v = String(import.meta.env?.VITE_APP_VERSION ?? '').slice(0, 24)
  if (/^[A-Za-z0-9._-]+$/.test(v)) ctx.v = v
  return (ctxCache = ctx)
}

/** The request bodies for the queued events (exported for tests): chunks of ≤ 50, `dt` = ms ago. */
export function buildBatches(events: Queued[], now: number, id: string, ctx: Record<string, string>): string[] {
  const out: string[] = []
  for (let i = 0; i < events.length; i += MAX_BATCH) {
    const chunk = events.slice(i, i + MAX_BATCH).map((e) => {
      const ev: Record<string, unknown> = { type: e.type, dt: Math.min(600_000, Math.max(0, now - e.t)) }
      if (Object.keys(e.p).length) ev.p = e.p
      return ev
    })
    out.push(JSON.stringify({ sid: id, ctx, events: chunk }))
  }
  return out
}

/** Send everything queued. `beacon` on page hide (sendBeacon survives the unload). */
export function flush(beacon = false): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  if (!queue.length) return
  const events = queue
  queue = []
  try {
    for (const body of buildBatches(events, Date.now(), sessionId(), context())) sender(body, beacon)
  } catch {
    /* dropped */
  }
}

function defaultSender(body: string, beacon: boolean): void {
  // text/plain: a "simple" request, so neither sendBeacon nor keepalive fetch needs a preflight.
  if (beacon && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) return
  void fetch(ENDPOINT, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'content-type': 'text/plain' } }).catch(() => undefined)
}

let started = false
/** Flush on page hide. Returns false (and does nothing) when telemetry is off. */
export function startTelemetry(): boolean {
  if (!isAllowed()) return false
  if (started) return true
  started = true
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush(true)
  }
  addEventListener('visibilitychange', onHide)
  addEventListener('pagehide', () => flush(true))
  return true
}

/** Test hooks. */
export function _testing(opts: { allowed?: boolean; sender?: Sender; ctx?: Record<string, string>; sid?: string }): { queue: () => Queued[] } {
  allowed = opts.allowed
  if (opts.sender) sender = opts.sender
  ctxCache = opts.ctx
  sid = opts.sid
  queue = []
  lastShareAt = -Infinity
  enricher = undefined
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  return { queue: () => queue }
}
