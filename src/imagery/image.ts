/**
 * Image loading for the imagery module.
 *
 *  - `preloadImage(url)` fetches + decodes off the main thread (`img.decode()`), so the UI can
 *    swap a fully decoded picture in without a paint stall. Results are kept in an in-memory
 *    LRU keyed by URL, and concurrent callers share one load. NASA GIBS photos (I-1) are fetched in
 *    the pixels worker, which also measures their no-data share on a 32 px decode; the element shows
 *    the very bytes it checked (a blob: URL), so nothing is drawn or read back on the main thread.
 *  - `probeImage(url)` decodes a (tiny) image and measures how much of it is no-data
 *    (transparent or pure black). GIBS answers "no data yet" with a black JPEG instead of an
 *    error, so this is the only reliable way to tell an empty frame from a real one. The fetch
 *    and decode run in a worker (pixelsClient.ts) when the browser allows.
 *
 * All images are requested with `crossOrigin="anonymous"`: every archive we use sends
 * `Access-Control-Allow-Origin: *`, and CORS-clean pixels can be read back (probe, canvas
 * reveal) or uploaded as WebGL textures. Consumers rendering `<img>` should set the same
 * `crossOrigin` so the browser reuses the decoded image instead of fetching it again.
 */
import { GIBS_WMS } from './endpoints'
import { Lru, memoAsync } from './lru'
import { HttpError, raceAbort, sleep, withRetry } from './net'
import { measureNoData } from './pixels'
import { fetchCheckedImage, fetchPixels } from './pixelsClient'

export { decodeImagePixels, measureNoData } from './pixels'

const IMAGE_TIMEOUT_MS = 45_000 // PC renders crops on demand: 1–3 s typical, much longer on a cold cache
const imageCache = /* @__PURE__ */ new Lru<string, Promise<HTMLImageElement>>(96)

/**
 * NASA GIBS answered with an all-black image: "no data" in GIBS's dialect (not processed yet, a
 * swath gap, a missing frame, or a young frame on a lagging backend). Not retried: Chromium keeps
 * a loaded image for its URL for the life of the document, `no-store` or not (measured: a second
 * `new Image()` or `<img>` with the same URL made no request), so a retry would only see the same
 * black pixels. Callers should move on (e.g. to an older frame), as `latestGeoImage` does.
 */
export class EmptyImageError extends Error {
  constructor(url: string) {
    super(`NASA GIBS returned an empty frame for ${url.slice(0, 120)}…`)
    this.name = 'EmptyImageError'
  }
}

/** Share of no-data pixels at which a GIBS image counts as empty (a real frame is never this black). */
const EMPTY_NO_DATA = 0.98

const isGibsUrl = (url: string) => url.startsWith(GIBS_WMS)

/**
 * A NASA GIBS photo for display (I-1): fetched and checked for "no data" in the pixels worker (its 32 px decode),
 * then shown from the very bytes that were checked (a blob: URL, decoded off the main thread by `img.decode()`).
 * The object URL is never revoked: the decoded element and its clones (one per view, results/images.ts) load
 * from it for the whole session.
 */
async function loadGibs(url: string, timeoutMs: number): Promise<HTMLImageElement> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let checked
  try {
    checked = await fetchCheckedImage(url, ctl.signal)
  } catch (err) {
    throw ctl.signal.aborted ? new Error(`Image timed out after ${Math.round(timeoutMs / 1000)} s`) : err
  } finally {
    clearTimeout(timer)
  }
  if (!checked.blob) throw new Error('Image failed to load') // an HTTP error, or WMS's 200 + XML error
  if ((checked.noData ?? 0) >= EMPTY_NO_DATA) throw new EmptyImageError(url)
  return loadOnce(URL.createObjectURL(checked.blob), timeoutMs)
}

function loadOnce(url: string, timeoutMs: number): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    let settled = false
    const done = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      img.onload = img.onerror = null
      if (err) {
        img.src = '' // stop the download
        reject(err)
      } else resolve(img)
    }
    const timer = setTimeout(() => done(new Error(`Image timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
    img.onerror = () => done(new Error('Image failed to load'))
    img.onload = () => {
      // decode() can reject for images that loaded fine on some engines (e.g. very large PNGs
      // under memory pressure); the pixels are still usable then, so fall back to onload.
      if (typeof img.decode === 'function') img.decode().then(() => done(), () => done())
      else done()
    }
    img.src = url
  })
}

/**
 * Load and decode an image, with one retry for transient failures (PC's tiler occasionally
 * 5xxs on a cold scene). Cached by URL; failures are not cached.
 *
 * NASA GIBS images are also checked (in the pixels worker, I-1): an all-black response is GIBS saying
 * "no data" with a 200, so it rejects with `EmptyImageError` (no retry, see there) rather than resolving a
 * black square. Show the resolved element (or a clone: same `src`), never a fresh `<img src={url}>`: a
 * Sentinel-2 / Landsat crop would be a cache hit (Chromium reuses the document's loaded image for the same URL
 * and CORS mode), but a GIBS element's `src` is the blob: URL of the bytes that were checked, so `url` itself
 * was never loaded as an image (GIBS sends `no-store`: a fresh `<img>` would download it again).
 */
export function preloadImage(url: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<HTMLImageElement> {
  const timeoutMs = opts.timeoutMs ?? IMAGE_TIMEOUT_MS
  const load = () => (isGibsUrl(url) && typeof URL.createObjectURL === 'function' ? loadGibs(url, timeoutMs) : loadOnce(url, timeoutMs))
  const p = memoAsync(imageCache, url, async () => {
    try {
      return await load()
    } catch (err) {
      if (err instanceof EmptyImageError) throw err
      await sleep(700 + Math.random() * 500)
      return load()
    }
  })
  return raceAbort(p, opts.signal)
}

/** True if `url` has already been decoded and is still in the cache (for instant swaps). */
export function isImageCached(url: string): boolean {
  return imageCache.has(url)
}

export interface ImageProbe {
  /** 0..1 share of pixels that are transparent or (near) pure black */
  noDataFraction: number
  /** 0..255 mean luma of the pixels that do carry data */
  meanLuma: number
  width: number
  height: number
}


/**
 * When each mostly-empty probe was measured. Those expire: today's daily mosaic fills in over the
 * day, and a young geostationary frame can be empty on one GIBS backend and complete on the next.
 * Probes that found data are kept (archived pixels don't disappear).
 */
const emptyProbeAt = /* @__PURE__ */ new Map<string, number>()
const EMPTY_PROBE_TTL_MS = 5 * 60_000
const probeCache = /* @__PURE__ */ new Lru<string, Promise<ImageProbe>>(256, (url) => emptyProbeAt.delete(url))

/**
 * Fetch an image (keep it small: a 16–32 px render is plenty) and measure its no-data share.
 * Cached by URL; concurrent callers share one request. A 200 response that isn't an image
 * (WMS reports errors as 200 + XML) counts as fully empty. Rejects on network/HTTP failure.
 */
export function probeImage(url: string, signal?: AbortSignal): Promise<ImageProbe> {
  const emptyAt = emptyProbeAt.get(url)
  if (emptyAt !== undefined && Date.now() - emptyAt > EMPTY_PROBE_TTL_MS) {
    emptyProbeAt.delete(url)
    probeCache.delete(url)
  }
  const p = memoAsync(probeCache, url, async () => {
    const probe = await withRetry(
      async (s): Promise<ImageProbe> => {
        // Fetched and decoded in the pixels worker (K8); only the tiny RGBA buffer comes back.
        const r = await fetchPixels(url, s)
        if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, url)
        if (!r.pixels) return { noDataFraction: 1, meanLuma: 0, width: 0, height: 0 }
        const { data, width, height } = r.pixels
        return { ...measureNoData(data), width, height }
      },
      { timeoutMs: 15_000, retries: 1, label: url },
    )
    if (probe.noDataFraction > 0.5) emptyProbeAt.set(url, Date.now())
    return probe
  })
  return raceAbort(p, signal)
}
