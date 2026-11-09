/**
 * Image → RGBA pixels, for the checks that read pixels back: GIBS "no data" probes (24 px renders) and the
 * Sentinel-2 SCL box at the place (10 px). Worker-safe: OffscreenCanvas when available, DOM canvas otherwise.
 *
 * pixels.worker.ts runs `fetchPixelsHere` off the main thread (K8: a report reads ~40 probes during the
 * camera flight; fetch → blob → decode → draw → read back was ~200 ms of main-thread work on a 4×-throttled
 * phone). pixelsClient.ts talks to it and falls back to this module in the calling thread.
 *
 * `fetchCheckedImageHere` (I-1) does the same for the NASA GIBS photos the panel SHOWS: fetch, measure the no-data
 * share on a 32 px decode, and hand back the image bytes, so the caller shows a picture known to have pixels
 * without ever drawing the full image on the main thread (createImageBitmap(HTMLImageElement) there cost 2–27 ms
 * per GIBS image on a phone).
 */

export interface Pixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** The outcome of fetching an image for its pixels (an HTTP error is a value here, not a throw). */
export interface PixelFetch {
  status: number
  contentType: string
  /** Response text of a non-2xx answer (PC explains "outside dataset bounds" there) */
  body?: string
  /** Decoded pixels, for a 2xx image response */
  pixels?: Pixels
}

type Readback = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
/** Read-back contexts by size, reused: a report reads ~40 tiny probes, and context creation dominated. */
const readbacks = /* @__PURE__ */ new Map<string, Readback | null>()

/**
 * A 2D context of `w`×`h` for reading pixels back: OffscreenCanvas when available (workers too). Shared per
 * size, in 'copy' mode, so each draw replaces the previous pixels (alpha included) without a clear.
 */
export function readbackContext(w: number, h: number): Readback | null {
  const key = `${w}x${h}`
  if (readbacks.has(key)) return readbacks.get(key)!
  let ctx: Readback | null = null
  if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
  else if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    ctx = c.getContext('2d', { willReadFrequently: true })
  }
  if (ctx) ctx.globalCompositeOperation = 'copy'
  if (readbacks.size > 16) readbacks.clear()
  readbacks.set(key, ctx)
  return ctx
}

/**
 * Decode an image blob to RGBA. With `size`, the decoder scales it (createImageBitmap resize) and only the
 * small bitmap is drawn for read-back. Colour management and premultiplication are off, so class rasters
 * (SCL) read back their exact values.
 */
export async function decodeImagePixels(blob: Blob, size?: number): Promise<Pixels> {
  const opts: ImageBitmapOptions = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }
  if (size) Object.assign(opts, { resizeWidth: size, resizeHeight: size, resizeQuality: 'low' })
  const bmp = await createImageBitmap(blob, opts)
  try {
    const { width, height } = bmp
    const ctx = readbackContext(width, height)
    if (!ctx) throw new Error('2D canvas unavailable')
    ctx.drawImage(bmp, 0, 0)
    return { data: ctx.getImageData(0, 0, width, height).data, width, height }
  } finally {
    bmp.close()
  }
}

/** Fetch `url` and decode it to pixels in this thread (the worker's job, and the fallback without one). */
export async function fetchPixelsHere(url: string, signal?: AbortSignal): Promise<PixelFetch> {
  const res = await fetch(url, { signal })
  const contentType = res.headers.get('content-type') ?? ''
  if (!res.ok) return { status: res.status, contentType, body: await res.text().catch(() => undefined) }
  // WMS reports errors as 200 + XML: no pixels then.
  if (!contentType.startsWith('image/')) return { status: res.status, contentType }
  return { status: res.status, contentType, pixels: await decodeImagePixels(await res.blob()) }
}

/** Pixel counts as no-data when it's transparent or every channel is within JPEG noise of 0. */
const NO_DATA_MAX_CHANNEL = 6
const NO_DATA_MIN_ALPHA = 16

/** Measure no-data (transparent or near-black pixels) in RGBA pixels. */
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

/** Side of the decode the no-data check reads: averaging keeps it honest, 32² keeps it cheap. */
export const CHECK_PX = 32

/** An image fetched for display, with its no-data share measured (a non-2xx or non-image answer has no blob). */
export interface CheckedImage {
  status: number
  contentType: string
  /** The image bytes (2xx image responses) */
  blob?: Blob
  /** 0..1 share of no-data pixels, or undefined if they couldn't be read (the picture is trusted then) */
  noData?: number
}

/** Fetch `url` for display and measure its no-data share in this thread (the worker's job, and the fallback). */
export async function fetchCheckedImageHere(url: string, signal?: AbortSignal): Promise<CheckedImage> {
  const res = await fetch(url, { signal })
  const contentType = res.headers.get('content-type') ?? ''
  if (!res.ok || !contentType.startsWith('image/')) {
    await res.body?.cancel().catch(() => undefined)
    return { status: res.status, contentType }
  }
  const blob = await res.blob()
  let noData: number | undefined
  try {
    noData = measureNoData((await decodeImagePixels(blob, CHECK_PX)).data).noDataFraction
  } catch {
    noData = undefined // no decoder or 2D context here: trust the picture
  }
  return { status: res.status, contentType, blob, noData }
}
