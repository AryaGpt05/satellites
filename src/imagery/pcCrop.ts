/**
 * The Sentinel-2 / Landsat crop and cloud-mask URLs (Planetary Computer), built by api/_lib/toneRender.ts on the
 * place's UTM grid. Apart from ./endpoints.ts on purpose: the first screen reaches endpoints (the geocoder's host),
 * never these, so the grid arithmetic (toneRender + utm) loads with the search, not with the landing (vite.config.ts
 * PURE_IMAGERY_MODULES keeps the '@/imagery' barrel's re-exports of this module off the first screen too).
 * Synchronous and side-effect free, like endpoints.
 */
import type { LatLon } from '@/types'
import { maskUrl, pcCropUrlAt, tonePlanForUrl } from '../../api/_lib/toneRender'
import { sanitizeCrop, type CropOpts, type StacCollection } from './endpoints'

/** Which way true north points in a crop built here (degrees clockwise from its up): the globe's panel square turns by it. */
export { northInCropDeg } from '../../api/_lib/toneRender'

/**
 * Square crop of one STAC item, centred on `place`, rendered by Planetary Computer as the shared encoded render
 * (api/_lib/toneRender.ts: surface reflectance, square-root encoded). On the place's UTM grid (toneRender placeGrid:
 * whole native pixels; a scene on that grid is copied as it is, one from the neighbouring zone warped onto it with
 * Lanczos), else (`geographic`, or beyond UTM's latitudes) in lon/lat with a Lanczos warp. It is never shown as it
 * comes: image.ts tones it in the pixels worker (one global curve per photo) before anything displays it, and the
 * server's share card does the same, so every renderer shows the same pixels.
 */
export function pcCropUrl(collection: StacCollection, itemId: string, place: LatLon, opts: CropOpts): string {
  const { halfSizeKm, px } = sanitizeCrop(opts)
  return pcCropUrlAt(collection, itemId, place.lat, place.lon, halfSizeKm, px, 'png', !!opts.geographic)
}

/** A Sentinel-2 / Landsat crop of the encoded render: toned (image.ts) before anything shows it. */
export const isTonedUrl = (url: string) => tonePlanForUrl(url) !== null

/**
 * The capture's cloud classification (Sentinel-2 SCL / Landsat QA_PIXEL) over the photo's square around the place
 * rounded to 0.01°, as a 64 px numpy array in lon/lat: the spot check, the clear fraction and the photo's tone all
 * read it (one request per capture and place).
 */
export function pcMaskUrl(collection: StacCollection, itemId: string, place: LatLon): string {
  return maskUrl(collection, itemId, place.lat, place.lon)
}
