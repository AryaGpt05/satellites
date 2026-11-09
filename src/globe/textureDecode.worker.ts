/// <reference lib="webworker" />
/**
 * Earth-map decoding off the main thread (G-M1). One worker per page, created with the first upgrade (or a
 * prefetch). The main thread fetches the file (network is off-thread anyway) and hands the Blob over; this
 * worker decodes it and cuts the upload strips, so neither the decode nor the per-strip crop + flip (a CPU copy
 * of every pixel: 11–42 ms per 2048×256 strip on the main thread of a 4× throttled phone) touches the main thread.
 * The main thread only uploads the strips it receives (texSubImage2D).
 *
 *   in:  { op: 'decode', id, req, blob }        decode and keep the bitmap as image `id`
 *        { op: 'strip', id, req, y, rows, flip } source rows [y, y + rows) of image `id`, flipped vertically
 *                                               when `flip` (the Earth maps: GL rows run south → north; regional
 *                                               images keep row 0 = north)
 *        { op: 'close', id }                    release image `id`
 *   out: { op: 'decoded', req, width, height }
 *        { op: 'strip', req, bitmap }           (transferred)
 *        { op: 'error', req, message }
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope
const images = new Map<number, ImageBitmap>()
const OPTS: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }

type In =
  | { op: 'decode'; id: number; req: number; blob: Blob }
  | { op: 'strip'; id: number; req: number; y: number; rows: number; flip: boolean }
  | { op: 'close'; id: number }

ctx.onmessage = async (ev: MessageEvent<In>) => {
  const m = ev.data
  if (m.op === 'close') {
    images.get(m.id)?.close()
    images.delete(m.id)
    return
  }
  try {
    if (m.op === 'decode') {
      const bmp = await createImageBitmap(m.blob, OPTS)
      images.set(m.id, bmp)
      ctx.postMessage({ op: 'decoded', req: m.req, width: bmp.width, height: bmp.height })
      return
    }
    const full = images.get(m.id)
    if (!full) throw new Error(`texture image ${m.id} is gone`)
    const strip = await createImageBitmap(full, 0, m.y, full.width, m.rows, m.flip ? { ...OPTS, imageOrientation: 'flipY' } : OPTS)
    ctx.postMessage({ op: 'strip', req: m.req, bitmap: strip }, [strip])
  } catch (err) {
    ctx.postMessage({ op: 'error', req: m.req, message: err instanceof Error ? err.message : String(err) })
  }
}
