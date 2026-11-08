/**
 * Endpoints and pure URL builders for the public archives (see docs/ARCHITECTURE.md, "Data sources").
 * Everything here is synchronous and side-effect free so it can be unit tested exactly.
 */
import { bboxAround } from '@/lib/geo'
import type { LatLon } from '@/types'

export const PC_STAC_SEARCH = 'https://planetarycomputer.microsoft.com/api/stac/v1/search'
export const PC_DATA = 'https://planetarycomputer.microsoft.com/api/data/v1'
export const ES_STAC_SEARCH = 'https://earth-search.aws.element84.com/v1/search'
export const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
export const WORLDVIEW = 'https://worldview.earthdata.nasa.gov/'
export const PHOTON = 'https://photon.komoot.io'

export type StacCollection = 'sentinel-2-l2a' | 'landsat-c2-l2'

export interface CropOpts {
  /** Half the side of the square crop, km */
  halfSizeKm: number
  /** Output width = height, px */
  px: number
}

/** Fixed decimals keep URLs (and therefore browser + LRU cache keys) stable for the same place. */
const coord = (n: number) => n.toFixed(6)

/** Clamp to what the renderers accept and what's sensible to ask a free service for. */
export function sanitizeCrop({ halfSizeKm, px }: CropOpts): CropOpts {
  const h = Number.isFinite(halfSizeKm) && halfSizeKm > 0 ? halfSizeKm : 3
  const p = Number.isFinite(px) ? Math.round(px) : 512
  return { halfSizeKm: Math.min(h, 2000), px: Math.min(2048, Math.max(8, p)) }
}

/**
 * Per-collection rendering of a PC data-API crop. These are the exact query strings documented
 * in ARCHITECTURE.md (S2: the 8-bit TCI "visual" asset; Landsat: L2 SR bands with a gamma/sigmoid
 * stretch). Strings, not URLSearchParams, because the API wants `assets` repeated and the
 * colour formula's commas unescaped.
 */
const PC_RENDER: Record<StacCollection, string> = {
  'sentinel-2-l2a': 'assets=visual&asset_bidx=visual%7C1%2C2%2C3&nodata=0',
  'landsat-c2-l2':
    'assets=red&assets=green&assets=blue&color_formula=gamma%20RGB%202.7,%20saturation%201.5,%20sigmoidal%20RGB%2015%200.55',
}

/**
 * Square PNG crop of one STAC item, centred on `place`, rendered by Planetary Computer.
 * bbox is lon/lat order: minx (west), miny (south), maxx (east), maxy (north).
 */
export function pcCropUrl(collection: StacCollection, itemId: string, place: LatLon, opts: CropOpts): string {
  const { halfSizeKm, px } = sanitizeCrop(opts)
  const [w, s, e, n] = bboxAround(place.lat, place.lon, halfSizeKm)
  return (
    `${PC_DATA}/item/bbox/${coord(w)},${coord(s)},${coord(e)},${coord(n)}/${px}x${px}.png` +
    `?collection=${collection}&item=${encodeURIComponent(itemId)}&${PC_RENDER[collection]}`
  )
}

/** Single-pixel value of one asset at the place (used for the spot cloud check). */
export function pcPointUrl(collection: StacCollection, itemId: string, place: LatLon, asset: string): string {
  return (
    `${PC_DATA}/item/point/${coord(place.lon)},${coord(place.lat)}` +
    `?collection=${collection}&item=${encodeURIComponent(itemId)}&assets=${encodeURIComponent(asset)}`
  )
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

/** NASA Worldview deep link: the same layer, day and region, in a human map viewer. */
export function worldviewUrl(layer: string, date: string, place: LatLon, halfSizeKm = 400): string {
  const [w, s, e, n] = bboxAround(place.lat, place.lon, halfSizeKm)
  const f = (v: number) => v.toFixed(4)
  return `${WORLDVIEW}?v=${f(w)},${f(s)},${f(e)},${f(n)}&l=${encodeURIComponent(layer)},Coastlines_15m&t=${encodeURIComponent(date)}`
}
