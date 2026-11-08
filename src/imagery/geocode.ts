/**
 * Places: forward search and reverse lookup (Photon / OpenStreetMap), browser geolocation, and
 * time zones (offline, @photostructure/tz-lookup).
 *
 * Labels are built for a two-line display: `label` is the thing itself ("Waterloo"),
 * `sublabel` is where it is ("Ontario, Canada"), with no part repeated.
 */
import tzlookup from '@photostructure/tz-lookup'
import { haversineKm } from '@/lib/geo'
import type { LatLon, Place } from '@/types'
import { fmtLat, fmtLon } from '@/ui/system/format'
import { PHOTON } from './endpoints'
import { Lru } from './lru'
import { fetchJson, HttpError, isAbortError, throwIfAborted } from './net'

// ── Photon wire types ──────────────────────────────────────────────────────────────────────

export interface PhotonProperties {
  name?: string
  housenumber?: string
  street?: string
  locality?: string
  district?: string
  city?: string
  county?: string
  state?: string
  country?: string
  countrycode?: string
  postcode?: string
  osm_key?: string
  osm_value?: string
  type?: string
}

export interface PhotonFeature {
  type?: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: PhotonProperties
}

export interface PhotonResponse {
  features: PhotonFeature[]
}

// ── Label building (pure) ──────────────────────────────────────────────────────────────────

/** Case- and accent-insensitive key: "Tōkyō" and "tokyo" compare equal. */
export function textKey(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Join non-empty parts with ", ", dropping repeats and anything equal to `exclude`. */
export function joinUnique(parts: (string | undefined)[], exclude: (string | undefined)[] = []): string | undefined {
  const seen = new Set(exclude.filter((x): x is string => !!x).map(textKey))
  const out: string[] = []
  for (const p of parts) {
    const t = p?.trim()
    if (!t) continue
    const k = textKey(t)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out.length ? out.join(', ') : undefined
}

/** "43.4723°N 80.5449°W" */
export function coordinateLabel(lat: number, lon: number): string {
  return `${fmtLat(lat)} ${fmtLon(lon)}`
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** A forward-search result → Place. Undefined if the feature has no usable position. */
export function photonToPlace(f: PhotonFeature, source: Place['source'] = 'search'): Place | undefined {
  const [lon, lat] = f.geometry?.coordinates ?? []
  if (!finite(lat) || !finite(lon)) return undefined
  const p = f.properties ?? {}
  const address = p.street ? joinUnique([[p.housenumber, p.street].filter(Boolean).join(' ')]) : undefined
  const label = p.name?.trim() || address || p.city || p.district || p.county || p.state || p.country || coordinateLabel(lat, lon)
  return {
    lat,
    lon,
    label,
    sublabel: joinUnique([p.city, p.state, p.country], [label]),
    countryCode: p.countrycode?.toLowerCase() || undefined,
    source,
  }
}

const SETTLEMENT = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'quarter', 'borough', 'municipality', 'locality', 'island', 'islet'])
const NAMED_LAND = new Set(['natural', 'waterway', 'place', 'mountain_pass'])

/**
 * A reverse-geocoding hit → Place at the *queried* coordinates. The nearest OSM object is often a
 * shop or a tree ("Class of 1995"), which is not what anyone means by "where I am", so prefer the
 * settlement (city / district / locality), then a named natural feature, then the region.
 */
export function photonReverseToPlace(f: PhotonFeature, lat: number, lon: number, source: Place['source'] = 'geolocation'): Place {
  const p = f.properties ?? {}
  const city = p.city && !/^unorganized\b/i.test(p.city) ? p.city : undefined
  const label =
    (p.osm_key === 'place' && p.osm_value && SETTLEMENT.has(p.osm_value) ? p.name : undefined) ||
    city ||
    p.district ||
    p.locality ||
    (p.osm_key && NAMED_LAND.has(p.osm_key) ? p.name : undefined) ||
    p.county ||
    p.state ||
    p.country ||
    coordinateLabel(lat, lon)
  return {
    lat,
    lon,
    label,
    sublabel: joinUnique([p.state, p.country], [label]),
    countryCode: p.countrycode?.toLowerCase() || undefined,
    source,
  }
}

/**
 * Drop near-identical results: same name (accent/case-insensitive) within 25 km is the same
 * place to a person (OSM often has a city node, its boundary relation and its station).
 * The first (best-ranked) wins.
 */
export function dedupePlaces(places: Place[], withinKm = 25): Place[] {
  const out: Place[] = []
  for (const p of places) {
    const k = textKey(p.label)
    if (out.some((q) => textKey(q.label) === k && haversineKm(p, q) < withinKm)) continue
    out.push(p)
  }
  return out
}

/**
 * Coordinates typed into the search box: "43.4723, -80.5449", "43.4723 -80.5449",
 * "43.4723°N 80.5449°W", "43.4723N,80.5449W". Null if it isn't a coordinate pair.
 */
export function parseCoordinates(q: string): LatLon | null {
  const s = q.trim().toUpperCase().replace(/[°º]/g, ' ')
  const m = /^([+-]?\d{1,2}(?:\.\d+)?)\s*([NS])?\s*[,;\s]\s*([+-]?\d{1,3}(?:\.\d+)?)\s*([EW])?$/.exec(s)
  if (!m) return null
  let lat = Number(m[1])
  let lon = Number(m[3])
  if (m[2] === 'S') lat = -Math.abs(lat)
  if (m[4] === 'W') lon = -Math.abs(lon)
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null
  return { lat, lon }
}

// ── Network ────────────────────────────────────────────────────────────────────────────────

const PHOTON_TIMEOUT_MS = 8_000
const searchCache = new Lru<string, Place[]>(48)

/**
 * Up to 6 places matching `q`, best first, in English where OSM has it. Coordinates are accepted
 * and reverse-geocoded. Resolves [] for queries under 2 characters or that Photon rejects.
 * Rejects on network failure (show "search unavailable") and on abort.
 */
export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  throwIfAborted(signal)
  const query = q.trim().replace(/\s+/g, ' ')
  if (query.length < 2) return []
  const key = textKey(query)
  const hit = searchCache.get(key)
  if (hit) return hit

  const coords = parseCoordinates(query)
  if (coords) {
    const place = { ...(await reversePlace(coords.lat, coords.lon, signal)), source: 'search' as const }
    return [place]
  }

  let res: PhotonResponse
  try {
    res = await fetchJson<PhotonResponse>(`${PHOTON}/api/?q=${encodeURIComponent(query)}&limit=6&lang=en`, {
      signal,
      timeoutMs: PHOTON_TIMEOUT_MS,
      retries: 1,
    })
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) return [] // e.g. a query of only punctuation
    throw err
  }
  const places = dedupePlaces((res.features ?? []).map((f) => photonToPlace(f)).filter((p): p is Place => !!p))
  searchCache.set(key, places)
  return places
}

/**
 * Name the place at (lat, lon). Never rejects except on abort: if Photon has nothing nearby (open
 * ocean, ice sheet) or can't be reached, the label is the coordinates themselves.
 * The returned position is exactly (lat, lon), not the matched OSM object's.
 */
export async function reversePlace(lat: number, lon: number, signal?: AbortSignal): Promise<Place> {
  throwIfAborted(signal)
  const fallback: Place = { lat, lon, label: coordinateLabel(lat, lon), source: 'geolocation' }
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return fallback
  try {
    const res = await fetchJson<PhotonResponse>(
      `${PHOTON}/reverse?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&lang=en&limit=1&radius=25`,
      { signal, timeoutMs: PHOTON_TIMEOUT_MS, retries: 1 },
    )
    const f = res.features?.[0]
    return f ? photonReverseToPlace(f, lat, lon) : fallback
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err
    return fallback
  }
}

// ── Geolocation ────────────────────────────────────────────────────────────────────────────

export type LocateErrorCode = 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'insecure'

/** A geolocation failure with a message fit to show as-is. */
export class LocateError extends Error {
  readonly code: LocateErrorCode
  constructor(code: LocateErrorCode, message: string) {
    super(message)
    this.name = 'LocateError'
    this.code = code
  }
}

const LOCATE_MESSAGES: Record<LocateErrorCode, string> = {
  denied: 'Location access is blocked. Allow it in your browser settings, or search for a place.',
  unavailable: 'Your position isn’t available right now. Search for a place instead.',
  timeout: 'Finding your position took too long. Try again, or search for a place.',
  unsupported: 'This browser can’t share its location. Search for a place instead.',
  insecure: 'Location needs a secure (https) connection. Search for a place instead.',
}

const LOCATE_TIMEOUT_MS = 10_000
/**
 * Hard cap while the permission prompt is open. The API's own `timeout` only starts once
 * permission is granted, and some browsers never call back if the prompt is ignored.
 */
const LOCATE_PROMPT_CAP_MS = 30_000

/**
 * The device's position. Rejects with a LocateError whose message is ready to display.
 * Coarse accuracy is plenty (a pass covers kilometres) and much faster on desktop.
 */
export function locateMe(): Promise<LatLon> {
  return new Promise<LatLon>((resolve, reject) => {
    const fail = (code: LocateErrorCode) => reject(new LocateError(code, LOCATE_MESSAGES[code]))
    if (typeof window !== 'undefined' && window.isSecureContext === false) return fail('insecure')
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined
    if (!geo) return fail('unsupported')
    let done = false
    const cap = setTimeout(() => {
      if (done) return
      done = true
      fail('timeout')
    }, LOCATE_PROMPT_CAP_MS)
    geo.getCurrentPosition(
      (pos) => {
        if (done) return
        done = true
        clearTimeout(cap)
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude })
      },
      (err) => {
        if (done) return
        done = true
        clearTimeout(cap)
        fail(err.code === err.PERMISSION_DENIED ? 'denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable')
      },
      { enableHighAccuracy: false, timeout: LOCATE_TIMEOUT_MS, maximumAge: 5 * 60_000 },
    )
  })
}

// ── Time zone ──────────────────────────────────────────────────────────────────────────────

/** IANA time zone at a position ("America/Toronto"). Offline; open sea gets "Etc/GMT±N". */
export function timeZoneAt(lat: number, lon: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'UTC'
  const la = Math.max(-90, Math.min(90, lat))
  const lo = ((((lon + 180) % 360) + 360) % 360) - 180
  try {
    return tzlookup(la, lo)
  } catch {
    return 'UTC'
  }
}
