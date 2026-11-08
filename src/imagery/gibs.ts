/**
 * NASA GIBS imagery: daily true-colour mosaics from polar weather imagers (VIIRS, MODIS) and
 * 10-minute GeoColor / visible frames from geostationary imagers (GOES-East/West, Himawari).
 *
 * GIBS never says "no data": a day that hasn't been processed yet, a swath gap or a missing
 * frame all come back as HTTP 200 with a black JPEG. So every weather capture is verified with a
 * tiny pixel probe (24×24 px) before it is returned, and empty ones are dropped.
 *
 * Measured latency (2026-11-08, ~03:45Z): the newest GOES-East frame listed by GIBS was 65 min
 * old, and requests for frames 50–60 min old were answered inconsistently (black on some edge
 * nodes, real on others). Hence the 70-minute safety lag in `geoFrameTime`.
 */
import type { Capture, CaptureCollection, LatLon, Pass } from '@/types'
import { gibsWmsUrl, worldviewUrl, type CropOpts } from './endpoints'
import { probeImage } from './image'
import { mapLimit, throwIfAborted } from './net'

export type GibsCollection = Extract<CaptureCollection, `gibs-${string}`>

export interface GibsLayer {
  collection: GibsCollection
  layer: string
  /** Lowercase platform id, like STAC platforms ("noaa-20", "goes-east") */
  platform: string
  /** Effective ground sample distance of the GIBS product, metres */
  gsdM: number
  kind: 'daily' | 'subdaily'
  /** Frame cadence for sub-daily layers, minutes */
  cadenceMin?: number
}

export const GIBS_LAYERS: Readonly<Record<GibsCollection, GibsLayer>> = {
  'gibs-viirs-noaa20': { collection: 'gibs-viirs-noaa20', layer: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', platform: 'noaa-20', gsdM: 375, kind: 'daily' },
  'gibs-viirs-noaa21': { collection: 'gibs-viirs-noaa21', layer: 'VIIRS_NOAA21_CorrectedReflectance_TrueColor', platform: 'noaa-21', gsdM: 375, kind: 'daily' },
  'gibs-viirs-snpp': { collection: 'gibs-viirs-snpp', layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', platform: 'suomi-npp', gsdM: 375, kind: 'daily' },
  'gibs-modis-terra': { collection: 'gibs-modis-terra', layer: 'MODIS_Terra_CorrectedReflectance_TrueColor', platform: 'terra', gsdM: 250, kind: 'daily' },
  'gibs-modis-aqua': { collection: 'gibs-modis-aqua', layer: 'MODIS_Aqua_CorrectedReflectance_TrueColor', platform: 'aqua', gsdM: 250, kind: 'daily' },
  'gibs-goes-east': { collection: 'gibs-goes-east', layer: 'GOES-East_ABI_GeoColor', platform: 'goes-east', gsdM: 1000, kind: 'subdaily', cadenceMin: 10 },
  'gibs-goes-west': { collection: 'gibs-goes-west', layer: 'GOES-West_ABI_GeoColor', platform: 'goes-west', gsdM: 1000, kind: 'subdaily', cadenceMin: 10 },
  'gibs-himawari': { collection: 'gibs-himawari', layer: 'Himawari_AHI_Band3_Red_Visible_1km', platform: 'himawari', gsdM: 1000, kind: 'subdaily', cadenceMin: 10 },
}

/** Polar weather imagers whose daily mosaics GIBS serves, by NORAD id. */
export const GIBS_DAILY_BY_NORAD: Readonly<Record<number, GibsCollection>> = {
  43013: 'gibs-viirs-noaa20', // NOAA 20 (JPSS-1)
  54234: 'gibs-viirs-noaa21', // NOAA 21 (JPSS-2)
  37849: 'gibs-viirs-snpp', // Suomi NPP
  25994: 'gibs-modis-terra', // Terra
  27424: 'gibs-modis-aqua', // Aqua
}

export function isGibsCollection(c: string): c is GibsCollection {
  return Object.prototype.hasOwnProperty.call(GIBS_LAYERS, c)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "YYYY-MM-DD" of an instant, in UTC (GIBS daily layers are UTC days). */
export function utcDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** ISO-8601 to the second, "Z" suffix, no milliseconds. */
export function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const TEN_MIN = 10 * 60_000
/** Frames younger than this are not reliably served yet (see header). */
export const GEO_SAFE_LAG_MS = 70 * 60_000

/**
 * The geostationary frame to request for instant `ms`: never newer than now − 70 min, then
 * rounded DOWN to the 10-minute mark (GIBS snaps in-between times to the previous frame anyway,
 * but an exact mark keeps URLs, and caches, stable).
 */
export function geoFrameTime(ms: number, now = Date.now()): number {
  return Math.floor(Math.min(ms, now - GEO_SAFE_LAG_MS) / TEN_MIN) * TEN_MIN
}

/** WMS TIME value for a collection: a UTC date for daily mosaics, an ISO instant for frames. */
export function gibsTime(collection: GibsCollection, ms: number, now = Date.now()): string {
  return GIBS_LAYERS[collection].kind === 'daily' ? utcDate(ms) : isoSeconds(geoFrameTime(ms, now))
}

/**
 * A square GIBS image centred on `place` at instant `ms`. For GOES-East/West and Himawari this is
 * the 10-minute frame at (or just before) `ms`, held back to a frame that GIBS reliably serves;
 * for the daily layers, that UTC day's mosaic.
 */
export function geoImageUrl(collection: CaptureCollection, place: LatLon, ms: number, opts: CropOpts): string {
  if (!isGibsCollection(collection)) throw new TypeError(`${collection} is not served by NASA GIBS`)
  return gibsWmsUrl(GIBS_LAYERS[collection].layer, gibsTime(collection, ms), place, opts)
}

// ── Pixel probe ────────────────────────────────────────────────────────────────────────────

const PROBE_PX = 24
const PROBE_HALF_KM = 30
/**
 * Probes in flight at once. GIBS sits behind CloudFront over HTTP/2, so parallel probes share one
 * connection. Measured: 28 parallel probes ≈ 2.1 s, a 7-day report (35–40 candidates) ≈ 3–4 s,
 * dominated by GIBS render time (0.4–0.7 s per request, served in a staircase).
 */
const PROBE_CONCURRENCY = 12
/** A capture whose probe is more than half empty is dropped. */
export const MAX_NO_DATA = 0.5
/** Probe URL for "is there data at this place on this layer at this time". */
function probeUrl(layer: string, time: string, place: LatLon): string {
  return gibsWmsUrl(layer, time, place, { halfSizeKm: PROBE_HALF_KM, px: PROBE_PX })
}

// ── Weather captures from passes ───────────────────────────────────────────────────────────

/** Minimum sun elevation at the place for a true-colour daily mosaic to be worth showing. */
export const MIN_SUN_ELEVATION_DEG = 5

/** Pure part of `weatherCaptures`: which passes qualify, one per (layer, UTC day), as Captures. */
export function weatherCandidates(place: LatLon, passes: readonly Pass[]): Capture[] {
  const best = new Map<string, Pass>()
  for (const p of passes) {
    const collection = GIBS_DAILY_BY_NORAD[p.norad]
    if (!collection || !p.inSwath || !(p.sunElevationDeg >= MIN_SUN_ELEVATION_DEG)) continue
    // A daily mosaic is one image per UTC day: keep the pass closest to nadir (the one most
    // likely to have been used for that pixel), so two daytime passes don't produce two copies.
    const key = `${collection}@${utcDate(p.tClosest)}`
    const prev = best.get(key)
    if (!prev || p.groundDistanceKm < prev.groundDistanceKm) best.set(key, p)
  }
  const out: Capture[] = []
  for (const p of best.values()) {
    const info = GIBS_LAYERS[GIBS_DAILY_BY_NORAD[p.norad]]
    const date = utcDate(p.tClosest)
    const itemId = `${info.layer}@${date}`
    out.push({
      id: itemId,
      provider: 'gibs',
      collection: info.collection,
      itemId,
      platform: info.platform,
      norad: p.norad,
      datetime: p.tClosest,
      gsdM: info.gsdM,
      sunElevationDeg: p.sunElevationDeg,
      cropUrl: (o: CropOpts) => gibsWmsUrl(info.layer, date, place, o),
      previewUrl: gibsWmsUrl(info.layer, date, place, { halfSizeKm: 600, px: 1024 }),
      sourceUrl: worldviewUrl(info.layer, date, place),
    })
  }
  return out.sort((a, b) => b.datetime - a.datetime)
}

/**
 * True if GIBS has pixels at the place for this daily capture (probe is cached per URL).
 * For lazy use: show `weatherCandidates(...)` at once and verify each as it scrolls into view.
 * Resolves false when it can't be verified; rejects only on abort.
 */
export async function verifyWeatherCapture(capture: Capture, place: LatLon, signal?: AbortSignal): Promise<boolean> {
  const [layer, date] = capture.itemId.split('@')
  if (capture.provider !== 'gibs' || !layer || !date) return false
  try {
    const probe = await probeImage(probeUrl(layer, date, place), signal)
    return probe.noDataFraction <= MAX_NO_DATA
  } catch {
    throwIfAborted(signal)
    return false // unverifiable → drop: a black square is worse than no square
  }
}

/**
 * Real daily VIIRS / MODIS true-colour images for the daytime, in-swath passes of NOAA-20,
 * NOAA-21, Suomi NPP, Terra and Aqua. Each candidate is verified with a tiny pixel probe and
 * dropped if the place is mostly no-data (not processed yet, swath gap, instrument outage).
 * Newest first. Abortable. Never throws for an individual image; throws only on abort.
 */
export async function weatherCaptures(place: LatLon, passes: Pass[], signal?: AbortSignal): Promise<Capture[]> {
  throwIfAborted(signal)
  const cands = weatherCandidates(place, passes)
  const verdicts = await mapLimit(cands, PROBE_CONCURRENCY, (c) => verifyWeatherCapture(c, place, signal))
  throwIfAborted(signal)
  return cands.filter((_, i) => verdicts[i])
}

/**
 * The newest geostationary frame that actually has pixels at the place: walks back from
 * now − 60 min in 10-minute steps (up to `maxSteps`), probing each. Resolves null if none was
 * found (e.g. Himawari's visible band at night), in which case `geoImageUrl(…, Date.now(), …)`
 * is the best static guess.
 */
export async function latestGeoImage(
  collection: GibsCollection,
  place: LatLon,
  opts: CropOpts,
  { signal, now = Date.now(), maxSteps = 12 }: { signal?: AbortSignal; now?: number; maxSteps?: number } = {},
): Promise<{ url: string; time: number } | null> {
  const info = GIBS_LAYERS[collection]
  if (info.kind !== 'subdaily') throw new TypeError(`${collection} is a daily layer`)
  const start = Math.floor((now - 60 * 60_000) / TEN_MIN) * TEN_MIN
  for (let i = 0; i < maxSteps; i++) {
    throwIfAborted(signal)
    const t = start - i * TEN_MIN
    const time = isoSeconds(t)
    try {
      const probe = await probeImage(probeUrl(info.layer, time, place), signal)
      if (probe.noDataFraction <= MAX_NO_DATA) return { url: gibsWmsUrl(info.layer, time, place, opts), time: t }
    } catch {
      throwIfAborted(signal)
    }
  }
  return null
}
