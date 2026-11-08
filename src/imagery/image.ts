/**
 * Image loading for the imagery module.
 *
 *  - `preloadImage(url)` fetches + decodes off the main thread (`img.decode()`), so the UI can
 *    swap a fully decoded picture in without a paint stall. Results are kept in an in-memory
 *    LRU keyed by URL, and concurrent callers share one load.
 *  - `probeImage(url)` decodes a (tiny) image and measures how much of it is no-data
 *    (transparent or pure black). GIBS answers "no data yet" with a black JPEG instead of an
 *    error, so this is the only reliable way to tell an empty frame from a real one.
 *
 * All images are requested with `crossOrigin="anonymous"`: every archive we use sends
 * `Access-Control-Allow-Origin: *`, and CORS-clean pixels can be read back (probe, canvas
 * reveal) or uploaded as WebGL textures. Consumers rendering `<img>` should set the same
 * `crossOrigin` so the browser reuses the decoded image instead of fetching it again.
 */
import { GIBS_WMS } from './endpoints'
import { Lru, memoAsync } from './lru'
import { HttpError, raceAbort, sleep, withRetry } from './net'

const IMAGE_TIMEOUT_MS = 45_000 // PC renders crops on demand: 1–3 s typical, much longer on a cold cache
const imageCache = new Lru<string, Promise<HTMLImageElement>>(96)

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
/** Side of the thumbnail the emptiness check reads back; averaging keeps it honest, 32² keeps it cheap. */
const CHECK_PX = 32

const isGibsUrl = (url: string) => url.startsWith(GIBS_WMS)

/** No-data share of a decoded image, or undefined if its pixels can't be read (never blocks a load). */
function noDataOf(img: HTMLImageElement): number | undefined {
  try {
    let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
    if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(CHECK_PX, CHECK_PX).getContext('2d', { willReadFrequently: true })
    else {
      const c = document.createElement('canvas')
      c.width = c.height = CHECK_PX
      ctx = c.getContext('2d', { willReadFrequently: true })
    }
    if (!ctx) return undefined
    ctx.drawImage(img, 0, 0, CHECK_PX, CHECK_PX)
    return measureNoData(ctx.getImageData(0, 0, CHECK_PX, CHECK_PX).data).noDataFraction
  } catch {
    return undefined // tainted canvas or no 2D context: trust the load
  }
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
 * NASA GIBS images are also read back: an all-black response is GIBS saying "no data" with a 200,
 * so it rejects with `EmptyImageError` (no retry, see there) rather than resolving a black square.
 * Once this resolves, an `<img crossOrigin="anonymous">` with the same URL shows these very pixels
 * without a new request (Chromium reuses the document's loaded image), as does drawing the element.
 */
export function preloadImage(url: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<HTMLImageElement> {
  const timeoutMs = opts.timeoutMs ?? IMAGE_TIMEOUT_MS
  const load = async () => {
    const img = await loadOnce(url, timeoutMs)
    if (isGibsUrl(url) && (noDataOf(img) ?? 0) >= EMPTY_NO_DATA) throw new EmptyImageError(url)
    return img
  }
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

/** Pixel counts as no-data when it's transparent or every channel is within JPEG noise of 0. */
const NO_DATA_MAX_CHANNEL = 6
const NO_DATA_MIN_ALPHA = 16

/** Measure no-data in RGBA pixels. Exported for tests. */
export function measureNoData(rgba: Uint8ClampedArray | Uint8Array): { noDataFraction: number; meanLuma: number } {
  const n = rgba.length >> 2
  if (n === 0) return { noDataFraction: 1, meanLuma: 0 }
  let empty = 0
  let luma = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    const a = rgba[i + 3]
    if (a < NO_DATA_MIN_ALPHA || (r <= NO_DATA_MAX_CHANNEL && g <= NO_DATA_MAX_CHANNEL && b <= NO_DATA_MAX_CHANNEL)) empty++
    else luma += 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const full = n - empty
  return { noDataFraction: empty / n, meanLuma: full ? luma / full : 0 }
}

/**
 * When each mostly-empty probe was measured. Those expire: today's daily mosaic fills in over the
 * day, and a young geostationary frame can be empty on one GIBS backend and complete on the next.
 * Probes that found data are kept (archived pixels don't disappear).
 */
const emptyProbeAt = new Map<string, number>()
const EMPTY_PROBE_TTL_MS = 5 * 60_000
const probeCache = new Lru<string, Promise<ImageProbe>>(256, (url) => emptyProbeAt.delete(url))

/** Decode an image blob to RGBA. Worker-safe: OffscreenCanvas when available, DOM canvas otherwise. */
async function decodePixels(blob: Blob): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const bmp = await createImageBitmap(blob)
  try {
    const { width, height } = bmp
    let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
    if (typeof OffscreenCanvas !== 'undefined') {
      ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
    } else {
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      ctx = c.getContext('2d', { willReadFrequently: true })
    }
    if (!ctx) throw new Error('2D canvas unavailable')
    ctx.drawImage(bmp, 0, 0)
    return { data: ctx.getImageData(0, 0, width, height).data, width, height }
  } finally {
    bmp.close()
  }
}

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
        const res = await fetch(url, { signal: s })
        if (!res.ok) throw new HttpError(res.status, url)
        if (!(res.headers.get('content-type') ?? '').startsWith('image/')) return { noDataFraction: 1, meanLuma: 0, width: 0, height: 0 }
        const { data, width, height } = await decodePixels(await res.blob())
        return { ...measureNoData(data), width, height }
      },
      { timeoutMs: 15_000, retries: 1, label: url },
    )
    if (probe.noDataFraction > 0.5) emptyProbeAt.set(url, Date.now())
    return probe
  })
  return raceAbort(p, signal)
}
