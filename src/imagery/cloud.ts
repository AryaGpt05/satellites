/**
 * "Was it cloudy *at your spot*?" Scene-wide cloud cover says little about one point: a scene
 * can be 85 % cloud and clear over the place, or 5 % and cloud exactly on it. So we read the
 * archive's own per-pixel classification around the place, from ONE small request per capture and place: the
 * capture's cloud mask (api/_lib/tone.ts maskUrl: a 64 px numpy array of Sentinel-2 SCL / Landsat QA_PIXEL over
 * the photo's square around the place rounded to 0.01°, ~156 m / 234 m per cell, nearest resampling). The same
 * mask sets the photo's white point (tone.ts), so it is fetched once for both, in the pixels worker.
 *
 *  - spot: the majority class of the cells in the 1 km box around the exact place. Sentinel-2: 8, 9 = cloud
 *    (medium/high probability), 10 = thin cirrus, 3 = cloud shadow, 0/1 = no data/defective (ignored), anything
 *    else = clear. Thin cirrus is its own class: SCL 10 fires falsely over bright urban surfaces (measured:
 *    Waterloo, S2C 1 Nov 2026 is visibly clear and reads class 10), so it must not read as "cloud". Landsat C2 L2
 *    QA_PIXEL bits: 0 fill → unknown; 1 dilated cloud, 2 cirrus, 3 cloud → cloud; 4 cloud shadow → shadow.
 *  - clear fraction: the share of the photo's square that shows the ground (tone.ts clearFraction: cloud and
 *    shadow 0, thin cirrus ½), for the lead photo's ranking (results lib/photos.ts).
 *  - GIBS (daily mosaics, geostationary frames): no per-pixel mask → unknown.
 *
 * Results are cached per (mask, place); failures are not cached and resolve to 'unknown'.
 */
import type { Capture, LatLon } from '@/types'
import { bboxAround } from '@/lib/geo'
import { clearFraction, maskCellAtLatLon, maskPoint, type ToneMask } from '../../api/_lib/tone'
import { pcMaskUrl } from './pcCrop'
import { fetchMask } from './pixelsClient'
import { Lru, memoAsync } from './lru'
import { HttpError, isAbortError, raceAbort, throwIfAborted, withRetry } from './net'
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
  return classifyArea(values, classifyScl)
}

/** Majority verdict of a block of Landsat QA_PIXEL values (same rules as classifySclArea). */
export function classifyQaArea(values: ArrayLike<number>): SpotCloud {
  return classifyArea(values, classifyQaPixel)
}

function classifyArea(values: ArrayLike<number>, classify: (v: number) => SpotCloud): SpotCloud {
  const n = { clear: 0, cirrus: 0, cloud: 0, shadow: 0 }
  let valid = 0
  for (let i = 0; i < values.length; i++) {
    const c = classify(values[i])
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

/** The spot check's answer: the class at the place and, when the mask says, the clear share of the photo's square. */
export interface SpotCheck {
  spot: SpotCloud
  /** 0..1, see the header; undefined when unknown */
  clearFraction?: number
}

/** The mask request for a capture at a place, or null if this capture has no per-pixel mask we can read. */
export function spotMaskQuery(capture: Capture, place: LatLon): { url: string } | null {
  if (capture.provider === 'gibs') return null
  if (capture.collection === 'sentinel-2-l2a') {
    // Earth Search fallback captures carry a PC id only when it could be rebuilt.
    if (!isPcS2ItemId(capture.itemId)) return null
    return { url: pcMaskUrl('sentinel-2-l2a', capture.itemId, place) }
  }
  if (capture.collection === 'landsat-c2-l2') return { url: pcMaskUrl('landsat-c2-l2', capture.itemId, place) }
  return null
}

/** Half-size of the box the spot's majority is read over (km): 1 km across. */
const AREA_HALF_KM = 0.5

/**
 * The spot class from a mask: the majority of the cells whose centres lie in the 1 km box around the place (else the
 * cell under it). The mask is lon/lat (toneRender maskUrl); the place is taken on its side of the antimeridian.
 */
export function spotFromMask(mask: ToneMask, place: LatLon): SpotCloud {
  const [lon, lat] = maskPoint(mask, place.lat, place.lon)
  const [w, s, e, n] = bboxAround(lat, lon, AREA_HALF_KM)
  const values: number[] = []
  const cw = (mask.box[2] - mask.box[0]) / mask.w
  const ch = (mask.box[3] - mask.box[1]) / mask.h
  for (let y = 0; y < mask.h; y++) {
    const cy = mask.box[3] - (y + 0.5) * ch
    if (cy < s || cy > n) continue
    for (let x = 0; x < mask.w; x++) {
      const cx = mask.box[0] + (x + 0.5) * cw
      // No-data cells count as unreadable (NaN: both classifiers say 'unknown').
      if (cx >= w && cx <= e) values.push(mask.cls[y * mask.w + x] === 0 ? NaN : mask.raw[y * mask.w + x])
    }
  }
  if (!values.length) {
    const c = maskCellAtLatLon(mask, place.lat, place.lon)
    if (c < 0 || mask.cls[c] === 0) return 'unknown'
    values.push(mask.raw[c])
  }
  return mask.collection === 'sentinel-2-l2a' ? classifySclArea(values) : classifyQaArea(values)
}

const cache = /* @__PURE__ */ new Lru<string, Promise<SpotCheck>>(512)
const UNKNOWN: SpotCheck = { spot: 'unknown' }

/**
 * Cloud verdict at the place and the clear share of the photo's square, from the capture's mask. Resolves
 * { spot: 'unknown' } when the archive has no mask, the place falls outside the scene, or the service is
 * unreachable. Rejects only on abort.
 */
export async function spotCheck(capture: Capture, place: LatLon, signal?: AbortSignal): Promise<SpotCheck> {
  throwIfAborted(signal)
  const q = spotMaskQuery(capture, place)
  if (!q) return UNKNOWN
  const key = `${q.url}|${place.lat.toFixed(5)},${place.lon.toFixed(5)}`
  const shared = memoAsync(cache, key, () =>
    // Not tied to the caller's signal: other callers (and the photo's curve) wait on the same mask.
    withRetry(
      async (s) => {
        const r = await fetchMask(q.url, s)
        if (r.status < 200 || r.status >= 300 || !r.mask) throw new HttpError(r.status, q.url, r.body)
        return { spot: spotFromMask(r.mask, place), clearFraction: clearFraction(r.mask) }
      },
      { timeoutMs: 10_000, retries: 1, label: q.url },
    ),
  )
  try {
    return await raceAbort(shared, signal)
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err
    // A 4xx is the archive's final word (the place is off the scene): a real "unknown", worth caching. Network
    // trouble and 5xx aren't cached (memoAsync drops failures).
    if (err instanceof HttpError && err.status >= 400 && err.status < 500) cache.set(key, Promise.resolve(UNKNOWN))
    return UNKNOWN
  }
}

/** Cloud verdict at the place (see spotCheck). Rejects only on abort. */
export async function spotCloud(capture: Capture, place: LatLon, signal?: AbortSignal): Promise<SpotCloud> {
  return (await spotCheck(capture, place, signal)).spot
}
