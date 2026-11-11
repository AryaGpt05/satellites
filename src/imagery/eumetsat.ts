/**
 * EUMETSAT's public map service (EUMETView, a GeoServer WMS): the newest Meteosat frame around a place, for the
 * geostationary watchers NASA GIBS has no layer for (Europe, Africa, the Middle East, India).
 *
 * Why it works the way it does (measured 2026-11-11, 05:00–05:40Z):
 *  - Every layer publishes its own small capabilities document (1.6 kB gzipped, CORS `*`, cached for 2 minutes).
 *    Its time dimension reads "start/end/PT10M": the end is the newest frame, 22–27 minutes old then.
 *  - A TIME between two frames is answered with the NEAREST frame (`nearestValue="1"`), so only listed instants
 *    are ever asked for: the age on screen is the frame's own. A TIME past the newest frame is a 200 with an XML
 *    ServiceException, which the image loader reads as a failed load (no retry storm: the next frame back is tried).
 *  - Off the disc, and where a daylight product is masked at night, the JPEG is WHITE unless BGCOLOR says otherwise.
 *    Black is NASA GIBS's "no data" too, so the one emptiness check serves both services (image.ts).
 *  - Meteosat-9's natural-colour product is masked wherever the sun stands under about 3°. An 800 km square is whole
 *    once the sun is 6° up at its centre (`minSunDeg`).
 *  - A frame's GetMap answer carries `max-age=604800`: its URL (an exact TIME) is downloaded once per browser.
 *
 * The pictures are EUMETSAT "Advanced Image Products", which its Data Policy (25 November 2025) lists as Core data:
 * free and unrestricted, with the attribution of article 6.3 (About page, THIRD_PARTY_NOTICES.md). Nothing here goes
 * through our own servers.
 */
import { bboxAround, sunElevationDeg } from '@/lib/geo'
import type { LatLon } from '@/types'
import { EUMETSAT_GEOSERVER, EUMETSAT_WMS, sanitizeCrop, type CropOpts } from './endpoints'
import { isoSeconds, parseTimeDomain } from './gibs'
import { preloadImage } from './image'
import { isAbortError, raceAbort, throwIfAborted, withRetry } from './net'

/** A EUMETView layer as the frame search needs it. */
export interface EumetsatFrameLayer {
  /** "workspace:name", e.g. "mtg_fd:rgb_geocolour" */
  layer: string
  /** A daylight product: frames with the sun lower than this at the place are masked, so they are skipped */
  minSunDeg?: number
}

/**
 * WMS 1.3.0 GetMap in EPSG:4326 (BBOX is minLat,minLon,maxLat,maxLon, as for GIBS): a square in km around the place,
 * at one listed frame time. No data comes back black (see the header).
 */
export function eumetsatWmsUrl(layer: string, ms: number, place: LatLon, opts: CropOpts): string {
  const { halfSizeKm, px } = sanitizeCrop(opts)
  const [w, s, e, n] = bboxAround(place.lat, place.lon, halfSizeKm)
  const lat = (v: number) => Math.max(-90, Math.min(90, v)).toFixed(5)
  const lon = (v: number) => v.toFixed(5)
  return (
    `${EUMETSAT_WMS}?service=WMS&version=1.3.0&request=GetMap&layers=${encodeURIComponent(layer)}&styles=` +
    `&format=${encodeURIComponent('image/jpeg')}&crs=EPSG:4326&bbox=${lat(s)},${lon(w)},${lat(n)},${lon(e)}` +
    `&width=${px}&height=${px}&bgcolor=0x000000&time=${encodeURIComponent(isoSeconds(ms))}`
  )
}

/** One layer's own capabilities document (GeoServer's per-layer virtual service): small, and it names the newest frame. */
export function eumetsatCapabilitiesUrl(layer: string): string {
  const [workspace, name] = layer.split(':')
  return `${EUMETSAT_GEOSERVER}/${encodeURIComponent(workspace)}/${encodeURIComponent(name ?? '')}/ows?service=WMS&version=1.3.0&request=GetCapabilities`
}

/** How far back the frame list goes: far enough for a few steps back from the newest frame. */
const LIST_WINDOW_MS = 3 * 3_600_000
/** How long a frame list is trusted (the service caches the document for 2 minutes itself). */
const LIST_TTL_MS = 5 * 60_000

/** The time dimension of a capabilities document, as frame instants in [from, to], newest first. */
export function parseTimeDimension(xml: string, from: number, to: number): number[] {
  const domain = /<Dimension\b[^>]*\bname="time"[^>]*>([^<]+)<\/Dimension>/.exec(xml)?.[1]
  return domain ? parseTimeDomain(domain, from, to).reverse() : []
}

const lists = /* @__PURE__ */ new Map<string, { at: number; frames: Promise<number[]> }>()

/**
 * The frames EUMETView lists for a layer over the last 3 hours, newest first. One small XML request per layer,
 * shared by concurrent callers and kept for 5 minutes. Rejects on network failure and on abort.
 */
export function eumetsatFrames(layer: string, { signal, now = Date.now() }: { signal?: AbortSignal; now?: number } = {}): Promise<number[]> {
  let entry = lists.get(layer)
  if (!entry || Math.abs(now - entry.at) >= LIST_TTL_MS) {
    const url = eumetsatCapabilitiesUrl(layer)
    const frames = withRetry(
      async (s) => {
        const res = await fetch(url, { signal: s })
        const found = parseTimeDimension(await res.text(), now - LIST_WINDOW_MS, now)
        if (!res.ok || !found.length) throw new Error(`EUMETSAT lists no frames for ${layer}`)
        return found
      },
      { timeoutMs: 6_000, retries: 1, label: url },
    )
    const mine = (entry = { at: now, frames })
    lists.set(layer, mine)
    frames.catch(() => {
      if (lists.get(layer) === mine) lists.delete(layer)
    })
  }
  // A shared load: stop waiting on abort without cancelling it for other callers.
  return raceAbort(entry.frames, signal)
}

/** Which listed frames are worth trying, newest first: the newest `maxSteps`, less those a daylight product masks. */
export function eumetsatFrameCandidates(info: EumetsatFrameLayer, place: LatLon, listed: readonly number[], maxSteps = 4): number[] {
  const window = listed.slice(0, maxSteps)
  const min = info.minSunDeg
  return min === undefined ? window : window.filter((t) => sunElevationDeg(place.lat, place.lon, t) >= min)
}

/** True if a daylight product could have a frame for the place in the search window: no request is made otherwise. */
function sunWasUp(info: EumetsatFrameLayer, place: LatLon, now: number): boolean {
  const min = info.minSunDeg
  if (min === undefined) return true
  for (let t = now; t >= now - LIST_WINDOW_MS; t -= 10 * 60_000) if (sunElevationDeg(place.lat, place.lon, t) >= min) return true
  return false
}

/**
 * The newest frame EUMETView serves for the place on this layer, as a URL at `opts` size: the first of the newest few
 * listed frames that loads with pixels (`preloadImage` rejects an all-black answer, and the verified image stays
 * loaded, so showing the URL costs nothing more). Resolves null when nothing qualifies: a daylight product at night
 * (no request at all then), a place off the disc, the service down. Rejects only on abort. Browser only.
 */
export async function latestEumetsatFrame(
  info: EumetsatFrameLayer,
  place: LatLon,
  opts: CropOpts,
  { signal, now = Date.now(), maxSteps = 4 }: { signal?: AbortSignal; now?: number; maxSteps?: number } = {},
): Promise<{ url: string; time: number } | null> {
  if (!sunWasUp(info, place, now)) return null
  let listed: number[]
  try {
    listed = await eumetsatFrames(info.layer, { signal, now })
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err
    return null // no list, no frame: a guessed TIME would be answered with its nearest frame, at an unknown age
  }
  for (const t of eumetsatFrameCandidates(info, place, listed, maxSteps)) {
    throwIfAborted(signal)
    const url = eumetsatWmsUrl(info.layer, t, place, opts)
    try {
      await preloadImage(url, { signal })
      return { url, time: t }
    } catch {
      throwIfAborted(signal)
    }
  }
  return null
}
