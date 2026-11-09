/// <reference lib="webworker" />
/**
 * Pixel probes off the main thread (K8). One long-lived worker per page, created on the first probe.
 *
 *   in:  { type: 'fetch', id, url }   fetch the image and decode it (pixels.ts fetchPixelsHere)
 *        { type: 'image', id, url }   fetch an image for display and measure its no-data share (fetchCheckedImageHere)
 *        { type: 'abort', id }        abort that request
 *   out: { type: 'ok', id, r }        a PixelFetch (pixel buffer transferred) or a CheckedImage (blob)
 *        { type: 'error', id, name, message }   a network failure (TypeError) or an abort
 */
import { fetchCheckedImageHere, fetchPixelsHere } from './pixels'

const ctx = self as unknown as DedicatedWorkerGlobalScope
const inflight = new Map<number, AbortController>()

ctx.onmessage = async (ev: MessageEvent<{ type: 'fetch' | 'image'; id: number; url: string } | { type: 'abort'; id: number }>) => {
  const m = ev.data
  if (m?.type === 'abort') {
    inflight.get(m.id)?.abort()
    inflight.delete(m.id)
    return
  }
  if (m?.type !== 'fetch' && m?.type !== 'image') return
  const ctl = new AbortController()
  inflight.set(m.id, ctl)
  try {
    if (m.type === 'image') {
      ctx.postMessage({ type: 'ok', id: m.id, r: await fetchCheckedImageHere(m.url, ctl.signal) })
      return
    }
    const r = await fetchPixelsHere(m.url, ctl.signal)
    ctx.postMessage({ type: 'ok', id: m.id, r }, r.pixels ? [r.pixels.data.buffer as ArrayBuffer] : [])
  } catch (err) {
    const e = err as { name?: string; message?: string } | undefined
    ctx.postMessage({ type: 'error', id: m.id, name: e?.name ?? 'Error', message: e?.message ?? String(err) })
  } finally {
    inflight.delete(m.id)
  }
}
