/**
 * The real pixels for a share card: a square crop of the archived scene, centred on the place.
 *
 * These URL builders mirror src/imagery/endpoints.ts (the same Planetary Computer render recipes
 * and GIBS WMS axis order) so the card shows exactly what the app showed. They are duplicated,
 * not imported, because api/ is bundled separately from the browser app.
 */
import type { ShareCapture } from './share.js'

const PC_DATA = 'https://planetarycomputer.microsoft.com/api/data/v1'
const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
const EARTH_RADIUS_KM = 6371
const DEG = Math.PI / 180

const PC_RENDER: Record<'sentinel-2-l2a' | 'landsat-c2-l2', string> = {
  'sentinel-2-l2a': 'assets=visual&asset_bidx=visual%7C1%2C2%2C3&nodata=0',
  'landsat-c2-l2':
    'assets=red&assets=green&assets=blue&color_formula=gamma%20RGB%202.7,%20saturation%201.5,%20sigmoidal%20RGB%2015%200.55',
}

/** GIBS layer per collection, for captures whose itemId doesn't spell it out. */
const GIBS_LAYER: Partial<Record<ShareCapture['collection'], string>> = {
  'gibs-viirs-noaa20': 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
  'gibs-viirs-noaa21': 'VIIRS_NOAA21_CorrectedReflectance_TrueColor',
  'gibs-viirs-snpp': 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
  'gibs-modis-terra': 'MODIS_Terra_CorrectedReflectance_TrueColor',
  'gibs-modis-aqua': 'MODIS_Aqua_CorrectedReflectance_TrueColor',
  'gibs-goes-east': 'GOES-East_ABI_GeoColor',
  'gibs-goes-west': 'GOES-West_ABI_GeoColor',
  'gibs-himawari': 'Himawari_AHI_Band3_Red_Visible_1km',
}

/** Native ground sample distance by collection, metres (used when the capture omits it). */
const NATIVE_GSD_M: Record<ShareCapture['collection'], number> = {
  'sentinel-2-l2a': 10,
  'landsat-c2-l2': 30,
  'gibs-viirs-noaa20': 375,
  'gibs-viirs-noaa21': 375,
  'gibs-viirs-snpp': 375,
  'gibs-modis-terra': 250,
  'gibs-modis-aqua': 250,
  'gibs-goes-east': 1000,
  'gibs-goes-west': 1000,
  'gibs-himawari': 1000,
}

/** Square [minLon, minLat, maxLon, maxLat] of half-size km around a point (as src/lib/geo.ts). */
export function bboxAround(lat: number, lon: number, halfKm: number): [number, number, number, number] {
  const dLat = (halfKm / EARTH_RADIUS_KM) * (180 / Math.PI)
  const dLon = dLat / Math.max(0.01, Math.cos(lat * DEG))
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
}

/** True for Planetary Computer Sentinel-2 L2A item ids (Earth Search ids can't be cropped). */
export function isPcS2ItemId(id: string): boolean {
  return /^S2[A-Z]_MSIL2A_\d{8}T\d{6}_R\d{3}_T\d{2}[A-Z]{3}_\d{8}T\d{6}$/.test(id)
}

export interface CropPlan {
  url: string
  /** Half the side of the square on the ground, km */
  halfSizeKm: number
  /** Metres per output pixel */
  metresPerPx: number
  /** "SENTINEL-2 L2A" */
  source: string
}

/**
 * Plan the crop for a capture at a place, sized so one output pixel is about one native pixel
 * (10 m for Sentinel-2 → a 6.3 km square at 630 px). Null if the capture can't be cropped.
 */
export function cropPlan(capture: ShareCapture, lat: number, lon: number, px: number): CropPlan | null {
  const gsd = NATIVE_GSD_M[capture.collection] ?? capture.gsdM ?? 10
  // Landsat's 30 m is soft at 1:1 on a phone; render at 20 m/px so the card still reads as detail.
  const metresPerPx = capture.collection === 'landsat-c2-l2' ? 20 : gsd
  const halfSizeKm = Math.max(2, (metresPerPx * px) / 2000)
  const [w, s, e, n] = bboxAround(lat, lon, halfSizeKm)
  const c = (v: number) => v.toFixed(6)

  if (capture.collection === 'sentinel-2-l2a' || capture.collection === 'landsat-c2-l2') {
    if (capture.collection === 'sentinel-2-l2a' && !isPcS2ItemId(capture.itemId)) return null
    if (capture.collection === 'landsat-c2-l2' && !/^L[COTE]0\d_L2S[PR]_\d{6}_\d{8}_\d{2}_[A-Z0-9]{2}$/.test(capture.itemId)) return null
    return {
      url:
        `${PC_DATA}/item/bbox/${c(w)},${c(s)},${c(e)},${c(n)}/${px}x${px}.png` +
        `?collection=${capture.collection}&item=${encodeURIComponent(capture.itemId)}&${PC_RENDER[capture.collection]}`,
      halfSizeKm,
      metresPerPx,
      source: capture.collection === 'sentinel-2-l2a' ? 'SENTINEL-2 L2A' : 'LANDSAT C2 L2',
    }
  }

  // GIBS: itemId is "<layer>@<YYYY-MM-DD or ISO time>".
  const [layerRaw, time] = capture.itemId.split('@')
  const layer = GIBS_LAYER[capture.collection]
  if (!layer || !time || (layerRaw && layerRaw !== layer) || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(time)) return null
  const lat5 = (v: number) => Math.max(-90, Math.min(90, v)).toFixed(5)
  return {
    url:
      `${GIBS_WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(layer)}&STYLES=` +
      `&FORMAT=image%2Fjpeg&CRS=EPSG:4326&BBOX=${lat5(s)},${w.toFixed(5)},${lat5(n)},${e.toFixed(5)}` +
      `&WIDTH=${px}&HEIGHT=${px}&TIME=${encodeURIComponent(time)}`,
    halfSizeKm,
    metresPerPx,
    source: layer.split('_').slice(0, 2).join(' ').toUpperCase(),
  }
}

/**
 * Fetch an image and return it as a data URI satori can embed. Null on timeout, HTTP error,
 * a non-image response, or a suspiciously tiny body (PC returns a ~100-byte PNG for "no data").
 */
export async function fetchImageDataUri(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'image/png,image/jpeg' } })
    if (!res.ok) return null
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    if (type !== 'image/png' && type !== 'image/jpeg') return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength < 1024 || buf.byteLength > 8_000_000) return null
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
