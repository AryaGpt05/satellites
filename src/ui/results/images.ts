/**
 * Decoded photos, by URL (owner A2: a photo shown once never goes blank, reloads or re-fades).
 *
 * `loadPhoto(url)` goes through the imagery loader (fetch + decode off the main thread, one request per URL for
 * the life of the page) and remembers the decoded element, so any later mount can show it in its very first
 * frame (`decodedPhoto(url)`), with no "acquiring" state and no fade. `photoLog` counts what was requested and
 * decoded, per URL, for the flicker probe.
 *
 * `photoElement(view, url)` (R3-1) is the one <img> element a view shows a photo with, for the whole session; <Img/>
 * (./Img.tsx) attaches it. Every URL is one canonical (capture, size) crop (lib/photos.ts: cardUrl, thumbUrl,
 * hiResUrl), fetched once, always with crossOrigin="anonymous".
 */
import { preloadImage } from '@/imagery'

const decoded = new Map<string, HTMLImageElement>()
const inflight = new Map<string, Promise<HTMLImageElement>>()
const MAX = 200

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

// ── one <img> element per (view, photo) for the session (R3-1) ───────────────────────────────

/**
 * Where a photo is shown. Each view keeps ONE <img> element per photo for the whole session: a remount of the view
 * (Back to the summary, a filter toggled back, a slide scrolled away and back) re-attaches that same element, so it
 * never reloads, re-decodes, fires another load event or re-runs a fade. Two views that can be on screen together
 * (the lightbox over the gallery) each get their own element.
 */
export type PhotoView = 'hero' | 'detail' | 'lightbox' | 'lightbox-hi' | 'film' | 'list' | 'geo' | 'geo-look'

const PER_VIEW_MAX = 96
const viewEls = new Map<PhotoView, Map<string, HTMLImageElement>>()
/** Decoded elements one view has taken over as its own (the others clone them) */
const adopted = new WeakSet<HTMLImageElement>()

/** Whether `view` already has its element for `url` (shown before this session): show it in the first frame. */
export const hasPhotoElement = (view: PhotoView, url: string) => !!viewEls.get(view)?.has(url)

/**
 * The element `view` shows `url` with, or undefined while the photo is not decoded yet. The first view to ask takes
 * the loader's own decoded element; later views get a clone of it (same URL and CORS mode: the document's list of
 * available images serves it at once, with no request and no decode). Detached elements are dropped beyond
 * PER_VIEW_MAX per view (oldest first).
 */
export function photoElement(view: PhotoView, url: string): HTMLImageElement | undefined {
  let m = viewEls.get(view)
  if (!m) viewEls.set(view, (m = new Map()))
  const hit = m.get(url)
  if (hit) {
    m.delete(url)
    m.set(url, hit)
    return hit
  }
  const src = decoded.get(url)
  if (!src) return undefined
  let el: HTMLImageElement
  if (!adopted.has(src)) {
    adopted.add(src)
    el = src
  } else {
    el = src.cloneNode(false) as HTMLImageElement
    count(url, 'cloned')
  }
  el.draggable = false
  m.set(url, el)
  if (m.size > PER_VIEW_MAX) {
    for (const [u, e] of m) {
      if (m.size <= PER_VIEW_MAX) break
      if (!e.isConnected) m.delete(u)
    }
  }
  return el
}

// ── probe counters (dev / inspect builds read window.__photoLog) ──────────────────────────────

type Counter = { requested: number; decoded: number; cloned: number }
const log = new Map<string, Counter>()
function count(url: string, k: keyof Counter) {
  let c = log.get(url)
  if (!c) log.set(url, (c = { requested: 0, decoded: 0, cloned: 0 }))
  c[k]++
}
if (typeof window !== 'undefined' && (import.meta.env.DEV || import.meta.env.MODE === 'inspect')) {
  ;(window as unknown as { __photoLog?: () => Record<string, Counter> }).__photoLog = () => Object.fromEntries(log)
}
