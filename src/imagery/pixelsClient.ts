/**
 * `fetchPixels(url)`: fetch an image and decode it to RGBA in pixels.worker.ts, so the probes a report makes
 * during the camera flight cost the main thread only a message (K8). Same result as `fetchPixelsHere`, which
 * it falls back to when module workers or OffscreenCanvas are unavailable (tests, old engines, CSP) or the
 * worker fails to start (its requests in flight are re-run here).
 * `fetchCheckedImage(url)` (I-1): the same for a GIBS photo the panel shows: its bytes plus its no-data share.
 * `fetchToned(url)`: a Sentinel-2 / Landsat photo toned in the worker (its bytes, re-encoded). `fetchMask(url)`: a
 * capture's cloud mask (the spot check; the worker keeps it for the photos' curve).
 *
 * Abort semantics match fetch: aborting `signal` rejects at once with the signal's reason and aborts the
 * worker's request. A network failure rejects with a TypeError, as fetch does (withRetry retries those).
 */
import { fetchCheckedImageHere, fetchMaskHere, fetchPanSharpHere, fetchPixelsHere, fetchTonedHere, type CheckedImage, type MaskFetch, type PixelFetch } from './pixels'
import { abortReason } from './net'

type Kind = 'fetch' | 'image' | 'tone' | 'tone-png' | 'mask' | 'pan'
const HERE: Record<Kind, (url: string, signal?: AbortSignal) => Promise<unknown>> = {
  fetch: fetchPixelsHere,
  image: fetchCheckedImageHere,
  tone: (url, signal) => fetchTonedHere(url, signal, 'jpeg'),
  'tone-png': (url, signal) => fetchTonedHere(url, signal, 'png'),
  mask: (url) => fetchMaskHere(url),
  pan: fetchPanSharpHere,
}

interface Pending {
  kind: Kind
  url: string
  signal?: AbortSignal
  resolve: (r: unknown) => void
  reject: (e: unknown) => void
}

type WorkerReply = { type: 'ok'; id: number; r: unknown } | { type: 'error'; id: number; name: string; message: string }

/** undefined: not tried yet; null: unavailable (use this thread) */
let worker: Worker | null | undefined
let nextId = 1
const pending = new Map<number, Pending>()

function rebuildError(name: string, message: string): Error {
  if (name === 'TypeError') return new TypeError(message)
  const e = new Error(message)
  e.name = name
  return e
}

/** The worker died (failed to load, crashed): everything it held runs here instead. */
function retire(w: Worker) {
  if (worker === w) worker = null
  try {
    w.terminate()
  } catch {
    /* gone */
  }
  const held = [...pending.values()]
  pending.clear()
  for (const p of held) HERE[p.kind](p.url, p.signal).then(p.resolve, p.reject)
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return (worker = null)
  try {
    const w = new Worker(new URL('./pixels.worker.ts', import.meta.url), { type: 'module', name: 'pixels' })
    w.onmessage = (ev: MessageEvent<WorkerReply>) => {
      const m = ev.data
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.type === 'ok') p.resolve(m.r)
      else p.reject(rebuildError(m.name, m.message))
    }
    w.onerror = (ev) => {
      ev.preventDefault?.()
      retire(w)
    }
    w.onmessageerror = () => retire(w)
    worker = w
  } catch {
    worker = null
  }
  return worker
}

export function fetchPixels(url: string, signal?: AbortSignal): Promise<PixelFetch> {
  return request<PixelFetch>('fetch', url, signal)
}

/** Fetch an image for display and measure its no-data share, in the pixels worker when possible (I-1). */
export function fetchCheckedImage(url: string, signal?: AbortSignal): Promise<CheckedImage> {
  return request<CheckedImage>('image', url, signal)
}

/** Fetch a Sentinel-2 / Landsat crop and tone it (api/_lib/tone.ts), in the pixels worker when possible. */
export function fetchToned(url: string, signal?: AbortSignal, fmt: 'jpeg' | 'png' = 'jpeg'): Promise<CheckedImage> {
  return request<CheckedImage>(fmt === 'png' ? 'tone-png' : 'tone', url, signal)
}

/** A Landsat photo's pan-sharpened lightbox layer (panUrl.ts), in the pixels worker when possible. Rejects when the pan can't be had. */
export function fetchPanSharp(url: string, signal?: AbortSignal): Promise<CheckedImage> {
  return request<CheckedImage>('pan', url, signal)
}

/** A capture's cloud mask (tone.ts maskUrl), fetched once per session in the pixels worker when possible. */
export function fetchMask(url: string, signal?: AbortSignal): Promise<MaskFetch> {
  return request<MaskFetch>('mask', url, signal)
}

function request<T>(kind: Kind, url: string, signal?: AbortSignal): Promise<T> {
  const w = getWorker()
  if (!w) return HERE[kind](url, signal) as Promise<T>
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal))
    const id = nextId++
    const onAbort = () => {
      if (!pending.delete(id)) return
      worker?.postMessage({ type: 'abort', id })
      reject(abortReason(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => signal?.removeEventListener('abort', onAbort)
    pending.set(id, {
      kind,
      url,
      signal,
      resolve: (r) => (done(), resolve(r as T)),
      reject: (e) => (done(), reject(e)),
    })
    w.postMessage(kind === 'tone-png' ? { type: 'tone', id, url, fmt: 'png' } : { type: kind, id, url })
  })
}
