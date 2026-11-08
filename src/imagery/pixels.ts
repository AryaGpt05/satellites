/**
 * Image → RGBA pixels, for the checks that read pixels back: GIBS "no data" probes (24 px renders) and the
 * Sentinel-2 SCL box at the place (10 px). Worker-safe: OffscreenCanvas when available, DOM canvas otherwise.
 *
 * pixels.worker.ts runs `fetchPixelsHere` off the main thread (K8: a report reads ~40 probes during the
 * camera flight; fetch → blob → decode → draw → read back was ~200 ms of main-thread work on a 4×-throttled
 * phone). pixelsClient.ts talks to it and falls back to this module in the calling thread.
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
