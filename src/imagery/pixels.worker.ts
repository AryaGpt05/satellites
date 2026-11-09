/// <reference lib="webworker" />
/**
 * Pixel work off the main thread (K8, I-1, and the photos' tone). One long-lived worker per page, created on the
 * first request.
 *
 *   in:  { type: 'fetch', id, url }        fetch the image and decode it (pixels.ts fetchPixelsHere)
 *        { type: 'image', id, url }        fetch an image for display and measure its no-data share (fetchCheckedImageHere)
 *        { type: 'tone', id, url, fmt }    fetch a Sentinel-2 / Landsat crop and tone it (fetchTonedHere)
 *        { type: 'mask', id, url }         fetch a cloud mask (fetchMaskHere; kept here for the photos' curve too)
 *        { type: 'abort', id }             abort that request
 *   out: { type: 'ok', id, r }             a PixelFetch (pixel buffer transferred), a CheckedImage (blob) or a MaskFetch
 *        { type: 'error', id, name, message }   a network failure (TypeError) or an abort
 */
import { fetchCheckedImageHere, fetchMaskHere, fetchPixelsHere, fetchTonedHere } from './pixels'

const ctx = self as unknown as DedicatedWorkerGlobalScope
const inflight = new Map<number, AbortController>()

type In =
  | { type: 'fetch' | 'image' | 'mask'; id: number; url: string }
  | { type: 'tone'; id: number; url: string; fmt?: 'jpeg' | 'png' }
  | { type: 'abort'; id: number }

ctx.onmessage = async (ev: MessageEvent<In>) => {
  const m = ev.data
  if (m?.type === 'abort') {
    inflight.get(m.id)?.abort()
    inflight.delete(m.id)
    return
  }
  if (m?.type !== 'fetch' && m?.type !== 'image' && m?.type !== 'tone' && m?.type !== 'mask') return
  const ctl = new AbortController()
  inflight.set(m.id, ctl)
  try {
    if (m.type === 'image') {
      ctx.postMessage({ type: 'ok', id: m.id, r: await fetchCheckedImageHere(m.url, ctl.signal) })
      return
    }
    if (m.type === 'tone') {
      ctx.postMessage({ type: 'ok', id: m.id, r: await fetchTonedHere(m.url, ctl.signal, m.fmt) })
      return
    }
    if (m.type === 'mask') {
      // Shared by every caller (the spot check, the photos' curve): never aborted on one caller's behalf.
      ctx.postMessage({ type: 'ok', id: m.id, r: await fetchMaskHere(m.url) })
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
