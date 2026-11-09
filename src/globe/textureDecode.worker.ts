/// <reference lib="webworker" />
/**
 * Earth-map decoding off the main thread (G-M1). One worker per page, created with the first upgrade (or a
 * prefetch). The main thread fetches the file (network is off-thread anyway) and hands the Blob over; this
 * worker decodes it and cuts the upload strips, so neither the decode nor the per-strip crop + flip (a CPU copy
 * of every pixel: 11–42 ms per 2048×256 strip on the main thread of a 4× throttled phone) touches the main thread.
 * The main thread only uploads the strips it receives (texSubImage2D).
 *
 * Strips leave as plain RGBA BYTES (an ArrayBuffer, transferred), never as ImageBitmaps. On iOS WebKit an ImageBitmap
 * cut from another one can share its backing store, and texSubImage2D(ImageBitmap) is copied later in the GPU
 * process: closing the source (or the strip) right after the call let that memory be recycled before the copy ran,
 * and the iPhone's day / night maps came up holding stale rendered frames (space, satellite dots, a smaller globe)
 * wrapped around the planet. Bytes are copied synchronously by texSubImage2D, so nothing outlives its owner.
 *
 *   in:  { op: 'decode', id, req, blob }        decode and keep the bitmap as image `id`
 *        { op: 'strip', id, req, y, rows, flip } source rows [y, y + rows) of image `id`, flipped vertically
 *                                               when `flip` (the Earth maps: GL rows run south → north; regional
 *                                               images keep row 0 = north)
 *        { op: 'close', id }                    release image `id`
 *   out: { op: 'decoded', req, width, height, strips }  strips: false when this worker can't cut strips (no
 *                                               OffscreenCanvas 2D: WebKit before 16.4); the caller decodes
 *                                               on its own thread instead
 *        { op: 'strip', req, width, height, data } (data: RGBA bytes, transferred)
 *        { op: 'error', req, message, unavailable? }  unavailable: no 2D surface here (fall back, not fail)
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope
const images = new Map<number, ImageBitmap>()
const OPTS: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }

type In =
  | { op: 'decode'; id: number; req: number; blob: Blob }
  | { op: 'strip'; id: number; req: number; y: number; rows: number; flip: boolean }
  | { op: 'close'; id: number }

/** A 2D surface can exist in this worker (OffscreenCanvas with a 2D context). Asked once. */
let canCut: boolean | undefined
function stripsAvailable(): boolean {
  if (canCut === undefined) {
    try {
      canCut = typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d')
    } catch {
      canCut = false
    }
  }
  return canCut
}

class Unavailable extends Error {}

/** One reusable 2D surface per strip size (the maps are opaque, so the canvas' premultiplication is lossless). */
let surface: OffscreenCanvasRenderingContext2D | null = null

/** Source rows [y, y + rows) of `img` as RGBA bytes, flipped vertically when `flip`. */
function stripBytes(img: ImageBitmap, y: number, rows: number, flip: boolean): Uint8Array {
  const w = img.width
  if (!surface || surface.canvas.width !== w || surface.canvas.height !== rows) {
    if (!stripsAvailable()) throw new Unavailable('no OffscreenCanvas 2D in this worker')
    surface = new OffscreenCanvas(w, rows).getContext('2d', { willReadFrequently: true, alpha: true })
    if (!surface) throw new Unavailable('no 2D context in this worker')
  }
  const c = surface
  c.imageSmoothingEnabled = false
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.clearRect(0, 0, w, rows)
  if (flip) c.setTransform(1, 0, 0, -1, 0, rows)
  c.drawImage(img, 0, y, w, rows, 0, 0, w, rows)
  const px = c.getImageData(0, 0, w, rows).data
  return new Uint8Array(px.buffer, px.byteOffset, px.byteLength)
}

ctx.onmessage = async (ev: MessageEvent<In>) => {
  const m = ev.data
  if (m.op === 'close') {
    images.get(m.id)?.close()
    images.delete(m.id)
    return
  }
  try {
    if (m.op === 'decode') {
      if (!stripsAvailable()) {
        // Nothing here can cut strips: don't hold a decoded copy the caller can't use.
        ctx.postMessage({ op: 'decoded', req: m.req, width: 0, height: 0, strips: false })
        return
      }
      const bmp = await createImageBitmap(m.blob, OPTS)
      images.set(m.id, bmp)
      ctx.postMessage({ op: 'decoded', req: m.req, width: bmp.width, height: bmp.height, strips: true })
      return
    }
    const full = images.get(m.id)
    if (!full) throw new Error(`texture image ${m.id} is gone`)
    const data = stripBytes(full, m.y, m.rows, m.flip)
    ctx.postMessage({ op: 'strip', req: m.req, width: full.width, height: m.rows, data }, [data.buffer])
  } catch (err) {
    ctx.postMessage({ op: 'error', req: m.req, message: err instanceof Error ? err.message : String(err), unavailable: err instanceof Unavailable })
  }
}
