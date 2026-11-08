/**
 * "Was it cloudy *at your spot*?" Scene-wide cloud cover says little about one point: a scene
 * can be 85 % cloud and clear over the place, or 5 % and cloud exactly on it. So we read the
 * archive's own per-pixel classification around the place:
 *
 *  - Sentinel-2 L2A: Scene Classification Layer (SCL) over the 1 km box around the spot, as a
 *    10×10 px render (Planetary Computer /item/bbox, ~0.7 s), classified by majority: 8, 9 = cloud
 *    (medium/high probability), 10 = thin cirrus, 3 = cloud shadow, 0/1 = no data/defective (ignored),
 *    anything else = clear. Thin cirrus is its own class: SCL 10 fires falsely over bright urban
 *    surfaces (measured: Waterloo, S2C 1 Nov 2026 is visibly clear and reads class 10), so it must not
 *    read as "cloud". Where the box can't be read (no image decoder), the single pixel at the place.
 *  - Landsat C2 L2: QA_PIXEL bit flags at the place. bit 0 fill → unknown; bit 1 dilated cloud,
 *    bit 2 cirrus, bit 3 cloud → cloud; bit 4 cloud shadow → shadow; else clear.
 *  - GIBS (daily mosaics, geostationary frames): no per-pixel mask → unknown.
 *
 * Results are cached per (item, place); failures are not cached and resolve to 'unknown'.
 */
import type { Capture, LatLon } from '@/types'
import { pcPointUrl, pcSclAreaUrl } from './endpoints'
import { fetchPixels } from './pixelsClient'
import { Lru, memoAsync } from './lru'
import { fetchJson, HttpError, isAbortError, raceAbort, throwIfAborted, withRetry } from './net'
import { isPcS2ItemId } from './stac'

import type { SpotCloud } from '@/types'
export type { SpotCloud }

/** Sentinel-2 Scene Classification value → verdict. */
export function classifyScl(value: number | null | undefined): SpotCloud {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown'
  switch (Math.round(value)) {
    case 8:
    case 9:
      return 'cloud'
    case 10:
      return 'cirrus'
    case 3:
      return 'shadow'
    case 0: // no data
    case 1: // saturated / defective
      return 'unknown'
    default:
      return 'clear'
  }
}

/** Landsat Collection 2 QA_PIXEL bit flags → verdict. */
export function classifyQaPixel(value: number | null | undefined): SpotCloud {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown'
  const v = Math.round(value)
  if (v & (1 << 0)) return 'unknown' // fill
  if (v & ((1 << 1) | (1 << 2) | (1 << 3))) return 'cloud' // dilated cloud | cirrus | cloud
  if (v & (1 << 4)) return 'shadow'
  return 'clear'
}

/** Below this share of readable pixels, an SCL box says nothing (the place is at a scene edge). */
const MIN_VALID_SHARE = 0.5

/**
 * Majority verdict of a block of SCL values (the 1 km box around the spot). No-data / defective pixels
 * are ignored; a tie goes to the more pessimistic class (cloud > shadow > cirrus > clear), so the
 * ranking never promotes a scene on a coin flip.
 */
export function classifySclArea(values: ArrayLike<number>): SpotCloud {
  const n = { clear: 0, cirrus: 0, cloud: 0, shadow: 0 }
  let valid = 0
  for (let i = 0; i < values.length; i++) {
    const c = classifyScl(values[i])
    if (c === 'unknown') continue
    valid++
    n[c]++
  }
  if (valid === 0 || valid < values.length * MIN_VALID_SHARE) return 'unknown'
  const order = ['cloud', 'shadow', 'cirrus', 'clear'] as const
  let best: (typeof order)[number] = 'cloud'
  for (const k of order) if (n[k] > n[best]) best = k
  return best
}

interface PointResponse {
  coordinates?: [number, number]
  values?: (number | null)[]
  band_names?: string[]
}

const cache = /* @__PURE__ */ new Lru<string, Promise<SpotCloud>>(512)

/** The query we'd make for a capture, or null if this capture has no per-pixel mask we can read. */
export function spotCloudQuery(capture: Capture, place: LatLon): { url: string; classify: (v: number | null | undefined) => SpotCloud } | null {
  if (capture.provider === 'gibs') return null
  if (capture.collection === 'sentinel-2-l2a') {
    // Earth Search fallback captures carry a PC id only when it could be rebuilt.
    if (!isPcS2ItemId(capture.itemId)) return null
    return { url: pcPointUrl('sentinel-2-l2a', capture.itemId, place, 'SCL'), classify: classifyScl }
  }
  if (capture.collection === 'landsat-c2-l2') {
    return { url: pcPointUrl('landsat-c2-l2', capture.itemId, place, 'qa_pixel'), classify: classifyQaPixel }
  }
  return null
}

/** Half-size of the box an SCL majority is read over (km): 1 km across. */
const AREA_HALF_KM = 0.5
const AREA_PX = 10

/** The 1 km SCL box for a Sentinel-2 capture (Planetary Computer items only), or null. */
export function spotAreaQuery(capture: Capture, place: LatLon): { url: string } | null {
  if (capture.provider === 'gibs' || capture.collection !== 'sentinel-2-l2a' || !isPcS2ItemId(capture.itemId)) return null
  return { url: pcSclAreaUrl(capture.itemId, place, AREA_HALF_KM, AREA_PX) }
}

/** Raw class values of the SCL box (the PNG's first channel; transparent pixels are no data → 0). */
async function readSclArea(url: string): Promise<SpotCloud> {
  return withRetry(
    async (signal) => {
      // Fetched and decoded in the pixels worker (K8); only the 10×10 RGBA buffer comes back.
      const r = await fetchPixels(url, signal)
      if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, url, r.body)
      if (!r.pixels) throw new Error(`Not an image: ${r.contentType || 'no content type'}`)
      const { data } = r.pixels
      const values = new Uint8Array(data.length >> 2)
      for (let i = 0; i < values.length; i++) values[i] = data[i * 4 + 3] < 128 ? 0 : data[i * 4]
      return classifySclArea(values)
    },
    { timeoutMs: 10_000, retries: 1, label: url },
  )
}

const canDecode = () => typeof createImageBitmap === 'function'

/**
 * Cloud verdict at the place: the majority of the 1 km SCL box for Sentinel-2, the pixel's QA flags for
 * Landsat. Resolves 'unknown' when the archive has no mask, the place falls outside the scene, or the
 * service is unreachable. Rejects only on abort.
 */
export async function spotCloud(capture: Capture, place: LatLon, signal?: AbortSignal): Promise<SpotCloud> {
  throwIfAborted(signal)
  const area = canDecode() ? spotAreaQuery(capture, place) : null
  const q = spotCloudQuery(capture, place)
  if (!q && !area) return 'unknown'
  const key = area?.url ?? q!.url
  const shared = memoAsync(cache, key, async () => {
    // Not tied to the caller's signal: other callers may be waiting on the same lookup.
    if (area) {
      try {
        return await readSclArea(area.url)
      } catch (err) {
        if (!q) throw err
        // Box unreadable (decoder or render trouble): fall back to the single pixel.
      }
    }
    const r = await fetchJson<PointResponse>(q!.url, { timeoutMs: 10_000, retries: 1 })
    return q!.classify(r.values?.[0])
  })
  try {
    return await raceAbort(shared, signal)
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err
    // PC answers 4xx/500 "Point is outside dataset bounds" for places off the scene: a real
    // "unknown", worth caching. Network trouble isn't cached (memoAsync drops failures).
    if (err instanceof HttpError && /outside/i.test(err.body ?? '')) cache.set(key, Promise.resolve('unknown'))
    return 'unknown'
  }
}
