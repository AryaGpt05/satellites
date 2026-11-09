/**
 * Endpoints and pure URL builders for the public archives (see docs/ARCHITECTURE.md, "Data sources").
 * Everything here is synchronous and side-effect free so it can be unit tested exactly.
 */
import { bboxAround } from '@/lib/geo'
import type { LatLon } from '@/types'
import { maskUrl, pcCropUrlAt, tonePlanForUrl } from '../../api/_lib/toneRender'

export const PC_STAC_SEARCH = 'https://planetarycomputer.microsoft.com/api/stac/v1/search'
export const PC_DATA = 'https://planetarycomputer.microsoft.com/api/data/v1'
export const ES_STAC_SEARCH = 'https://earth-search.aws.element84.com/v1/search'
export const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
export const GIBS_WMTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0'
export const WORLDVIEW = 'https://worldview.earthdata.nasa.gov/'
export const PHOTON = 'https://photon.komoot.io'

export type StacCollection = 'sentinel-2-l2a' | 'landsat-c2-l2'

export interface CropOpts {
  /** Half the side of the square crop, km */
  halfSizeKm: number
  /** Output width = height, px */
  px: number
  /** In lon/lat (EPSG:4326), not on the place's UTM grid: the globe's decals */
  geographic?: boolean
}

/** Clamp to what the renderers accept and what's sensible to ask a free service for. */
export function sanitizeCrop({ halfSizeKm, px }: CropOpts): CropOpts {
  const h = Number.isFinite(halfSizeKm) && halfSizeKm > 0 ? halfSizeKm : 3
  const p = Number.isFinite(px) ? Math.round(px) : 512
  return { halfSizeKm: Math.min(h, 2000), px: Math.min(2048, Math.max(8, p)) }
}

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

/** Human-facing map of one PC item (HTML). */
export function pcItemMapUrl(collection: StacCollection, itemId: string): string {
  return `${PC_DATA}/item/map?collection=${collection}&item=${encodeURIComponent(itemId)}`
}

/**
 * NASA GIBS WMS 1.3.0 GetMap in EPSG:4326. **Axis order for EPSG:4326 in WMS 1.3.0 is lat,lon**,
 * so BBOX is minLat,minLon,maxLat,maxLon. The bbox is square in km, so a px×px image comes back
 * with ground-square pixels (the server stretches longitude for us).
 */
export function gibsWmsUrl(layer: string, time: string, place: LatLon, opts: CropOpts, format: 'image/jpeg' | 'image/png' = 'image/jpeg'): string {
  const { halfSizeKm, px } = sanitizeCrop(opts)
  const [w, s, e, n] = bboxAround(place.lat, place.lon, halfSizeKm)
  const lat = (v: number) => Math.max(-90, Math.min(90, v)).toFixed(5)
  const lon = (v: number) => v.toFixed(5)
  return (
    `${GIBS_WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(layer)}&STYLES=` +
    `&FORMAT=${encodeURIComponent(format)}&CRS=EPSG:4326` +
    `&BBOX=${lat(s)},${lon(w)},${lat(n)},${lon(e)}&WIDTH=${px}&HEIGHT=${px}&TIME=${encodeURIComponent(time)}`
  )
}

/**
 * GIBS WMTS DescribeDomains: the exact time domain GIBS publishes for a layer within [start, end],
 * e.g. `2026-11-08T02:50:00Z/2026-11-08T05:20:00Z/PT10M` (comma-separated, gaps left out).
 * CORS `*`, ~0.2 s. The tile matrix set only has to be one GIBS accepts; it doesn't change the
 * answer. Times are ISO instants without milliseconds.
 */
export function gibsDomainsUrl(layer: string, tileMatrixSet: string, startIso: string, endIso: string): string {
  return `${GIBS_WMTS}/${encodeURIComponent(layer)}/default/${encodeURIComponent(tileMatrixSet)}/all/${startIso}--${endIso}.xml`
}

/** NASA Worldview deep link: the same layer, day and region, in a human map viewer. */
export function worldviewUrl(layer: string, date: string, place: LatLon, halfSizeKm = 400): string {
  const [w, s, e, n] = bboxAround(place.lat, place.lon, halfSizeKm)
  const f = (v: number) => v.toFixed(4)
  return `${WORLDVIEW}?v=${f(w)},${f(s)},${f(e)},${f(n)}&l=${encodeURIComponent(layer)},Coastlines_15m&t=${encodeURIComponent(date)}`
}
