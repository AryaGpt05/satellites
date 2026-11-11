/**
 * Browser client for the Overflight backend (Supabase, RPC-only; see supabase/migrations).
 *
 *   recordLookup(place)   fire-and-forget usage telemetry (coarsened to ~10 km server-side)
 *   createShare(input)    store a shared pass → { id, url } | null
 *   getShare(id)          read a shared pass (counts a view) → Share | null
 *   getStats()            { total, last24h, places, cells } | null (cached for a minute)
 *
 * Talks to PostgREST directly with fetch (no supabase-js in the bundle), using the publishable key
 * from VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY. The key is public by design: it can only
 * call the four RPCs granted to `anon`.
 *
 * Contract: nothing here ever throws or rejects. If the env vars are missing, the network fails,
 * the request times out, or the response is malformed, the result is `null` (or a no-op), and the
 * app carries on without the feature.
 */
import type { Capture, CaptureCollection, Pass, Place } from '@/types'

// ── Types ───────────────────────────────────────────────────────────────────────────────────

/** The capture fields a share keeps: enough to re-render the crop and name the source. */
export interface ShareCapture {
  collection: CaptureCollection
  itemId: string
  provider?: Capture['provider']
  platform?: string
  datetime?: number
  cloudCoverPct?: number
  gsdM?: number
}

/** A Pass without its ground track. The server coarsens geometry to ~1 km / 1 s precision. */
export type SharePass = Partial<Omit<Pass, 'track'>>

export interface Share {
  id: string
  /** epoch ms */
  createdAt?: number
  placeLabel: string
  /** Rounded to 0.01° (~1 km) by the server */
  lat: number
  lon: number
  norad?: number
  satName?: string
  verdict?: Pass['verdict']
  /** epoch ms, to the second */
  tClosest?: number
  capture?: ShareCapture
  pass?: SharePass
  views?: number
}

export interface CreateShareInput {
  placeLabel: string
  lat: number
  lon: number
  pass: Pass
  capture?: Capture
  /** Display name for the card headline ("Sentinel-2C"); derived from the capture if omitted. */
  satName?: string
  /** N, the satellites that watched the place that week: the card reads "7 satellites watched Waterloo." (stored as pass.weekSatellites) */
  satellites?: number
}

export interface CreatedShare {
  id: string
  /** Absolute share link (/s/<id>), the one to copy and post */
  url: string
}

export interface StatsPlace {
  /** 0.1° grid cell id, "43.5,-80.5" */
  cell: string
  lat: number
  lon: number
  label?: string
  countryCode?: string
  count: number
}

export interface Stats {
  /** All-time lookups */
  total: number
  last24h: number
  /** Top cells of the last 7 days (each with ≥ 3 lookups), most looked-up first */
  places: StatsPlace[]
  /** Up to 2000 all-time [lat, lon, count] cells for a heatmap */
  cells: [number, number, number][]
  computedAt?: number
}

// ── Config ──────────────────────────────────────────────────────────────────────────────────

interface Config {
  url: string
  key: string
}

function readConfig(): Config | null {
  // Literal `import.meta.env.VITE_*` so Vite can inline the values at build time.
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim()
  const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim()
  if (!url || !key || !/^https:\/\/[^/]+/.test(url)) return null
  return { url: url.replace(/\/+$/, ''), key }
}

let warned = false
function config(): Config | null {
  const c = readConfig()
  if (!c && !warned && import.meta.env?.DEV) {
    warned = true
    console.info('[backend] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY not set: lookups, shares and stats are disabled.')
  }
  return c
}

/** True when the backend env vars are present (the features may still be unreachable). */
export function backendConfigured(): boolean {
  return readConfig() !== null
}

// ── Transport ───────────────────────────────────────────────────────────────────────────────

/**
 * Per-call timeouts. `read` (get_share) outlives boot's share cap on purpose: a share that answers after the
 * landing appeared still opens if the landing is untouched (controller, within 15 s of boot).
 */
export const TIMEOUTS = { lookup: 5_000, share: 10_000, read: 12_000, stats: 6_000 } as const

type RpcResult = { ok: true; data: unknown } | { ok: false; status: number }

/**
 * POST /rest/v1/rpc/<fn>. Resolves (never rejects) with the parsed JSON or a failure status
 * (0 = network error, timeout, abort, or not configured).
 */
async function rpc(fn: string, body: unknown, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<RpcResult> {
  const cfg = config()
  if (!cfg) return { ok: false, status: 0 }
  if (opts.signal?.aborted) return { ok: false, status: 0 }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  const onAbort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: cfg.key,
        authorization: `Bearer ${cfg.key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      credentials: 'omit',
      cache: 'no-store',
    })
    if (!res.ok) return { ok: false, status: res.status }
    // record_lookup returns 204 No Content.
    const text = res.status === 204 ? '' : await res.text()
    return { ok: true, data: text ? (JSON.parse(text) as unknown) : null }
  } catch {
    return { ok: false, status: 0 }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

// ── Validation helpers ──────────────────────────────────────────────────────────────────────

const SHARE_ID_RE = /^[0-9a-z]{8}$/
export const isShareId = (id: unknown): id is string => typeof id === 'string' && SHARE_ID_RE.test(id)

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const optNum = (v: unknown): number | undefined => (finite(v) ? v : undefined)
/** A finite number within [min, max], else undefined (out-of-range values are dropped, never clamped). */
const numIn = (v: unknown, min: number, max: number): number | undefined => (finite(v) && v >= min && v <= max ? v : undefined)
/** First `max` code points (never splits a surrogate pair, which JSON → jsonb would reject). */
const clip = (s: string, max: number): string => {
  const cps = Array.from(s)
  return cps.length > max ? cps.slice(0, max).join('') : s
}
const optStr = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? clip(v.trim(), max) : undefined)
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d
const VERDICTS = ['imaged', 'likely', 'could', 'overhead'] as const
const verdictOf = (v: unknown): Pass['verdict'] | undefined => (VERDICTS as readonly unknown[]).includes(v) ? (v as Pass['verdict']) : undefined
const COLLECTIONS: readonly CaptureCollection[] = [
  'sentinel-2-l2a',
  'landsat-c2-l2',
  'gibs-viirs-noaa20',
  'gibs-viirs-noaa21',
  'gibs-viirs-snpp',
  'gibs-modis-terra',
  'gibs-modis-aqua',
  'gibs-goes-east',
  'gibs-goes-west',
  'gibs-himawari',
  'sentinel-1-rtc',
]

/** "Waterloo" stays; "123 King St" or "43.4723°N 80.5449°W" fall back to the city in the sublabel. */
export function cityLevelLabel(place: Pick<Place, 'label' | 'sublabel'>): string | undefined {
  const specific = (s: string) => /\d/.test(s)
  const label = place.label?.trim()
  if (label && !specific(label)) return label.slice(0, 80)
  const city = place.sublabel?.split(',')[0]?.trim()
  return city && !specific(city) ? city.slice(0, 80) : undefined
}

/**
 * The label record_lookup stores ("by town", About page): a street, building or address the geocoder flagged
 * (`Place.streetLevel`, e.g. "Kalverstraat", "Rijksmuseum") is saved as its city, never by its own name.
 */
export function lookupLabel(place: Pick<Place, 'label' | 'sublabel' | 'streetLevel'>): string | undefined {
  if (!place.streetLevel) return cityLevelLabel(place)
  const city = place.sublabel?.split(',').map((s) => s.trim()).find((s) => s && !/\d/.test(s))
  return city ? city.slice(0, 80) : undefined
}

const PLATFORM_NAMES: Record<string, string> = {
  'noaa-20': 'NOAA-20',
  'noaa-21': 'NOAA-21',
  'suomi-npp': 'Suomi NPP',
  terra: 'Terra',
  aqua: 'Aqua',
  'goes-east': 'GOES-East',
  'goes-west': 'GOES-West',
  himawari: 'Himawari',
}

/** "sentinel-2c" → "Sentinel-2C", "landsat-9" → "Landsat 9" (for cards when no name was given). */
export function platformDisplayName(platform: string | undefined): string | undefined {
  if (!platform) return undefined
  const p = platform.trim().toLowerCase()
  const s2 = /^sentinel-(\d)([a-z])$/.exec(p)
  if (s2) return `Sentinel-${s2[1]}${s2[2].toUpperCase()}`
  const ls = /^landsat-(\d+)$/.exec(p)
  if (ls) return `Landsat ${ls[1]}`
  return PLATFORM_NAMES[p] ?? (p ? p[0].toUpperCase() + p.slice(1) : undefined)
}

// ── recordLookup ────────────────────────────────────────────────────────────────────────────

/**
 * Count one computed report for `place`. Fire-and-forget: resolves when done or given up, never
 * rejects. The server stores only the 0.1° cell, the country and a city-level label.
 */
export async function recordLookup(place: Place): Promise<void> {
  if (!finite(place?.lat) || !finite(place?.lon) || Math.abs(place.lat) > 90 || Math.abs(place.lon) > 180) return
  await rpc(
    'record_lookup',
    {
      // Coarsen before it leaves the browser, too (the server rounds to the same 0.1° cell).
      p_lat: round(place.lat, 1),
      p_lon: round(place.lon, 1),
      p_country: /^[a-z]{2}$/i.test(place.countryCode ?? '') ? place.countryCode!.toLowerCase() : null,
      p_label: lookupLabel(place) ?? null,
    },
    // No `keepalive`: this request needs a CORS preflight, and keepalive + preflight is rejected
    // outright by some browsers. It is sent while the page is open (a report just finished).
    { timeoutMs: TIMEOUTS.lookup },
  )
}

// ── createShare ─────────────────────────────────────────────────────────────────────────────

/** The JSON payload for create_share (exported for tests). Track dropped, numbers trimmed. */
export function sharePayload(input: CreateShareInput): Record<string, unknown> | null {
  const { pass, capture } = input
  const label = input.placeLabel?.trim()
  if (!label || !finite(input.lat) || !finite(input.lon) || Math.abs(input.lat) > 90 || Math.abs(input.lon) > 180) return null
  if (!pass || !finite(pass.norad) || !finite(pass.tClosest) || !verdictOf(pass.verdict)) return null
  const { track: _track, ...rest } = pass
  void _track
  const p: Record<string, unknown> = { ...rest }
  for (const [k, v] of Object.entries(p)) if (typeof v === 'number' && !Number.isFinite(v)) delete p[k]
  if (finite(input.satellites) && input.satellites >= 1) p.weekSatellites = Math.round(input.satellites)
  return {
    // The server caps labels at 120 characters (code points).
    placeLabel: Array.from(label).length > 120 ? `${clip(label, 119).trimEnd()}…` : label,
    lat: round(input.lat, 4),
    lon: round(input.lon, 4),
    satName: optStr(input.satName, 80) ?? platformDisplayName(capture?.platform),
    pass: p,
    capture: capture
      ? {
          collection: capture.collection,
          itemId: capture.itemId,
          provider: capture.provider,
          platform: capture.platform,
          datetime: capture.datetime,
          cloudCoverPct: optNum(capture.cloudCoverPct),
          gsdM: optNum(capture.gsdM),
          spot: capture.spot,
        }
      : undefined,
  }
}

/** Absolute share link for an id: what people paste. Unfurls with the card. */
export function shareUrl(id: string, origin: string = typeof location !== 'undefined' ? location.origin : ''): string {
  return `${origin}/s/${id}`
}

/** The 1200×630 card for a share (also what og:image points to). */
export function shareCardUrl(id: string, origin: string = typeof location !== 'undefined' ? location.origin : ''): string {
  return `${origin}/api/og?id=${id}`
}

/**
 * Store a shared pass. Resolves `{ id, url }`, or null when the backend is unavailable, the input
 * is invalid, or the server is rate-limiting this area (≥ 10 shares a minute).
 */
export async function createShare(input: CreateShareInput, opts: { signal?: AbortSignal } = {}): Promise<CreatedShare | null> {
  const payload = sharePayload(input)
  if (!payload) return null
  const r = await rpc('create_share', { payload }, { timeoutMs: TIMEOUTS.share, signal: opts.signal })
  if (!r.ok || !isShareId(r.data)) return null
  return { id: r.data, url: shareUrl(r.data) }
}

// ── getShare ────────────────────────────────────────────────────────────────────────────────

function captureOf(v: unknown): ShareCapture | undefined {
  if (!isObj(v) || !(COLLECTIONS as readonly unknown[]).includes(v.collection) || typeof v.itemId !== 'string' || !v.itemId) return undefined
  return {
    collection: v.collection as CaptureCollection,
    itemId: v.itemId,
    provider: v.provider === 'earth-search' || v.provider === 'planetary-computer' || v.provider === 'gibs' ? v.provider : undefined,
    platform: optStr(v.platform, 40),
    datetime: optNum(v.datetime),
    cloudCoverPct: numIn(v.cloudCoverPct, 0, 100),
    gsdM: numIn(v.gsdM, 0.1, 100_000),
  }
}

/**
 * The stored pass, re-validated field by field (same ranges as create_share), so the app never
 * renders a value the pass didn't have. Missing or implausible fields are left out.
 */
function passOf(v: unknown): SharePass | undefined {
  if (!isObj(v)) return undefined
  const p: SharePass = {
    id: optStr(v.id, 40),
    norad: numIn(v.norad, 1, 999_999_999),
    tClosest: optNum(v.tClosest),
    tStart: optNum(v.tStart),
    tEnd: optNum(v.tEnd),
    groundDistanceKm: numIn(v.groundDistanceKm, 0, 20_100),
    offNadirDeg: numIn(v.offNadirDeg, 0, 90),
    elevationDeg: numIn(v.elevationDeg, -90, 90),
    azimuthDeg: numIn(v.azimuthDeg, 0, 360),
    altitudeKm: numIn(v.altitudeKm, 100, 400_000),
    groundSpeedKmS: numIn(v.groundSpeedKmS, 0, 12),
    headingDeg: numIn(v.headingDeg, 0, 360),
    node: v.node === 'ascending' || v.node === 'descending' ? v.node : undefined,
    sunElevationDeg: numIn(v.sunElevationDeg, -90, 90),
    inSwath: typeof v.inSwath === 'boolean' ? v.inSwath : undefined,
    inFieldOfRegard: typeof v.inFieldOfRegard === 'boolean' ? v.inFieldOfRegard : undefined,
    verdict: verdictOf(v.verdict),
    captureId: optStr(v.captureId, 160),
  }
  for (const k of Object.keys(p) as (keyof SharePass)[]) if (p[k] === undefined) delete p[k]
  return p
}

/** Parse the get_share RPC result (exported for tests). Null unless it is a usable share. */
export function parseShare(v: unknown): Share | null {
  if (!isObj(v) || !isShareId(v.id)) return null
  const placeLabel = optStr(v.placeLabel, 120)
  if (!placeLabel || !finite(v.lat) || !finite(v.lon) || Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180) return null
  return {
    id: v.id,
    createdAt: optNum(v.createdAt),
    placeLabel,
    lat: v.lat,
    lon: v.lon,
    norad: numIn(v.norad, 1, 999_999_999),
    satName: optStr(v.satName, 80),
    verdict: verdictOf(v.verdict),
    tClosest: optNum(v.tClosest),
    capture: captureOf(v.capture),
    pass: passOf(v.pass),
    views: optNum(v.views),
  }
}

/** Read a shared pass and count the view. Null if unknown, malformed or unreachable. */
export async function getShare(id: string, opts: { signal?: AbortSignal } = {}): Promise<Share | null> {
  const clean = typeof id === 'string' ? id.trim().toLowerCase() : ''
  if (!isShareId(clean)) return null
  const r = await rpc('get_share', { p_id: clean }, { timeoutMs: TIMEOUTS.read, signal: opts.signal })
  return r.ok ? parseShare(r.data) : null
}

// ── getStats ────────────────────────────────────────────────────────────────────────────────

/** Parse the get_stats RPC result (exported for tests). */
export function parseStats(v: unknown): Stats | null {
  if (!isObj(v) || !finite(v.total) || !finite(v.last24h) || v.total < 0 || v.last24h < 0) return null
  const places: StatsPlace[] = Array.isArray(v.places)
    ? v.places.flatMap((p): StatsPlace[] =>
        isObj(p) && typeof p.cell === 'string' && finite(p.lat) && finite(p.lon) && finite(p.count)
          ? [{ cell: p.cell, lat: p.lat, lon: p.lon, label: optStr(p.label, 80), countryCode: optStr(p.countryCode, 2), count: p.count }]
          : [],
      )
    : []
  const cells: [number, number, number][] = Array.isArray(v.cells)
    ? v.cells.flatMap((c): [number, number, number][] =>
        Array.isArray(c) && c.length === 3 && c.every(finite) && Math.abs(c[0]) <= 90 && Math.abs(c[1]) <= 180 ? [[c[0], c[1], c[2]]] : [],
      )
    : []
  return { total: v.total, last24h: Math.min(v.last24h, v.total), places, cells, computedAt: optNum(v.computedAt) }
}

const STATS_TTL_MS = 60_000
let statsCache: { at: number; value: Promise<Stats | null> } | null = null

/** Usage stats. Shared by every caller on the page and refreshed at most once a minute. */
export function getStats(opts: { fresh?: boolean } = {}): Promise<Stats | null> {
  const now = Date.now()
  if (!opts.fresh && statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value
  const value = rpc('get_stats', {}, { timeoutMs: TIMEOUTS.stats }).then((r) => (r.ok ? parseStats(r.data) : null))
  statsCache = { at: now, value }
  // Don't hold on to a failure for a whole minute.
  void value.then((v) => {
    if (v === null && statsCache?.value === value) statsCache = null
  })
  return value
}

/** Test hook: forget cached stats. */
export function _resetBackendCache(): void {
  statsCache = null
}
