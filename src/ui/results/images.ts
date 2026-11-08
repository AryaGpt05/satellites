/**
 * Decoded photos, by URL (owner A2: a photo shown once never goes blank, reloads or re-fades).
 *
 * `loadPhoto(url)` goes through the imagery loader (fetch + decode off the main thread, one request per URL for
 * the life of the page) and remembers the decoded element, so any later mount can show it in its very first
 * frame (`decodedPhoto(url)`), with no "acquiring" state and no fade. `photoLog` counts what was requested and
 * decoded, per URL, for the flicker probe.
 */
import { preloadImage } from '@/imagery'

const decoded = new Map<string, HTMLImageElement>()
const inflight = new Map<string, Promise<HTMLImageElement>>()
const MAX = 72

/** The decoded element for `url`, if it has been loaded this session. */
export function decodedPhoto(url: string | undefined): HTMLImageElement | undefined {
  return url ? decoded.get(url) : undefined
}

/** Load + decode (shared, cached). Never starts a second request for the same URL. */
export function loadPhoto(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  const hit = decoded.get(url)
  if (hit) return Promise.resolve(hit)
  let p = inflight.get(url)
  if (!p) {
    count(url, 'requested')
    p = preloadImage(url).then(
      (img) => {
        inflight.delete(url)
        if (!decoded.has(url)) {
          decoded.set(url, img)
          count(url, 'decoded')
          if (decoded.size > MAX) decoded.delete(decoded.keys().next().value as string)
        }
        return img
      },
      (err) => {
        inflight.delete(url)
        throw err
      },
    )
    inflight.set(url, p)
  }
  if (!signal) return p
  // A caller that stops waiting never cancels the shared load (another view may need the same photo).
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    p!.then(resolve, reject)
  })
}

/** Warm a photo without caring about the result (neighbours ±2, the cover during the flight). */
export function warmPhoto(url: string | undefined): void {
  if (url && !decoded.has(url)) loadPhoto(url).catch(() => undefined)
}

// ── probe counters (dev / inspect builds read window.__photoLog) ──────────────────────────────

type Counter = { requested: number; decoded: number }
const log = new Map<string, Counter>()
function count(url: string, k: keyof Counter) {
  let c = log.get(url)
  if (!c) log.set(url, (c = { requested: 0, decoded: 0 }))
  c[k]++
}
if (typeof window !== 'undefined' && (import.meta.env.DEV || import.meta.env.MODE === 'inspect')) {
  ;(window as unknown as { __photoLog?: () => Record<string, Counter> }).__photoLog = () => Object.fromEntries(log)
}
