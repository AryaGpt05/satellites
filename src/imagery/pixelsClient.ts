/**
 * `fetchPixels(url)`: fetch an image and decode it to RGBA in pixels.worker.ts, so the probes a report makes
 * during the camera flight cost the main thread only a message (K8). Same result as `fetchPixelsHere`, which
 * it falls back to when module workers or OffscreenCanvas are unavailable (tests, old engines, CSP) or the
 * worker fails to start (its requests in flight are re-run here).
 *
 * Abort semantics match fetch: aborting `signal` rejects at once with the signal's reason and aborts the
 * worker's request. A network failure rejects with a TypeError, as fetch does (withRetry retries those).
 */
import { fetchPixelsHere, type PixelFetch } from './pixels'
import { abortReason } from './net'

interface Pending {
  url: string
  signal?: AbortSignal
  resolve: (r: PixelFetch) => void
  reject: (e: unknown) => void
}

type WorkerReply = { type: 'ok'; id: number; r: PixelFetch } | { type: 'error'; id: number; name: string; message: string }

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
  for (const p of held) fetchPixelsHere(p.url, p.signal).then(p.resolve, p.reject)
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
  const w = getWorker()
  if (!w) return fetchPixelsHere(url, signal)
  return new Promise<PixelFetch>((resolve, reject) => {
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
      url,
      signal,
      resolve: (r) => (done(), resolve(r)),
      reject: (e) => (done(), reject(e)),
    })
    w.postMessage({ type: 'fetch', id, url })
  })
}
