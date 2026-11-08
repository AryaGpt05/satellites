/**
 * "Was it cloudy *at your spot*?" Scene-wide cloud cover says little about one point: a scene
 * can be 85 % cloud and clear over the place, or 5 % and cloud exactly on it. So we read the
 * archive's own per-pixel classification at the place, via Planetary Computer's point endpoint:
 *
 *  - Sentinel-2 L2A: Scene Classification Layer (SCL). 8, 9 = cloud (medium/high probability),
 *    10 = thin cirrus (counted as cloud), 3 = cloud shadow, 0/1 = no data/defective → unknown,
 *    anything else = clear.
 *  - Landsat C2 L2: QA_PIXEL bit flags. bit 0 fill → unknown; bit 1 dilated cloud, bit 2 cirrus,
 *    bit 3 cloud → cloud; bit 4 cloud shadow → shadow; else clear.
 *  - GIBS (daily mosaics, geostationary frames): no per-pixel mask → unknown.
 *
 * Results are cached per (item, place); failures are not cached and resolve to 'unknown'.
 */
import type { Capture, LatLon } from '@/types'
import { pcPointUrl } from './endpoints'
import { Lru, memoAsync } from './lru'
import { fetchJson, HttpError, isAbortError, raceAbort, throwIfAborted } from './net'
import { isPcS2ItemId } from './stac'

export type SpotCloud = 'clear' | 'cloud' | 'shadow' | 'unknown'

/** Sentinel-2 Scene Classification value → verdict. */
export function classifyScl(value: number | null | undefined): SpotCloud {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown'
  switch (Math.round(value)) {
    case 8:
    case 9:
    case 10:
      return 'cloud'
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

interface PointResponse {
  coordinates?: [number, number]
  values?: (number | null)[]
  band_names?: string[]
}

const cache = new Lru<string, Promise<SpotCloud>>(512)

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

/**
 * Cloud verdict for the single pixel under the place. Resolves 'unknown' when the archive has
 * no mask, the place falls outside the scene, or the service is unreachable. Rejects only on abort.
 */
export async function spotCloud(capture: Capture, place: LatLon, signal?: AbortSignal): Promise<SpotCloud> {
  throwIfAborted(signal)
  const q = spotCloudQuery(capture, place)
  if (!q) return 'unknown'
  const shared = memoAsync(cache, q.url, async () => {
    // Not tied to the caller's signal: other callers may be waiting on the same lookup.
    const r = await fetchJson<PointResponse>(q.url, { timeoutMs: 10_000, retries: 1 })
    return q.classify(r.values?.[0])
  })
  try {
    return await raceAbort(shared, signal)
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err
    // PC answers 4xx/500 "Point is outside dataset bounds" for places off the scene: a real
    // "unknown", worth caching. Network trouble isn't cached (memoAsync drops failures).
    if (err instanceof HttpError && /outside/i.test(err.body ?? '')) cache.set(q.url, Promise.resolve('unknown'))
    return 'unknown'
  }
}
