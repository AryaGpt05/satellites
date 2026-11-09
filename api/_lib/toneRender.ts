/**
 * The Sentinel-2 / Landsat render every renderer asks Planetary Computer for, its cloud-mask request, and which
 * region a crop's tone is measured over (see ./tone.ts for the whole method). Only URL arithmetic: small, so the
 * first screen (which reaches these builders through src/imagery/endpoints.ts) carries none of the pixel code.
 * Self-contained (no imports): the browser bundle and the functions share it.
 */

export type ToneCollection = 'sentinel-2-l2a' | 'landsat-c2-l2'
export type Box = [west: number, south: number, east: number, north: number]

const PC_DATA = 'https://planetarycomputer.microsoft.com/api/data/v1'
const EARTH_RADIUS_KM = 6371
const DEG = Math.PI / 180

/** Surface reflectance at the top of the encoded range. Sunlit snow under a low sun passes 1 on slopes; 1.0 keeps most of it. */
export const ENC_TOP_REFL = 1.0

/** Native ground sample distance (m) of the true-colour bands. */
export const NATIVE_GSD_M: Record<ToneCollection, number> = { 'sentinel-2-l2a': 10, 'landsat-c2-l2': 30 }

/** Half side (km) of the app's photo crop (results lib/captures cropSpec) and of the mask box. */
export const CROP_HALF_KM: Record<ToneCollection, number> = { 'sentinel-2-l2a': 5, 'landsat-c2-l2': 7.5 }

/**
 * Half side (km) of the region the curve is measured over: the share card's crop (cardSpec cardCrop: 630 px at
 * 10 m for Sentinel-2, 20 m for Landsat), which the server's crop IS and the app's photo contains.
 */
export const REF_HALF_KM: Record<ToneCollection, number> = { 'sentinel-2-l2a': 3.15, 'landsat-c2-l2': 6.3 }

export const isToneCollection = (c: string): c is ToneCollection => c === 'sentinel-2-l2a' || c === 'landsat-c2-l2'

/** Square [W, S, E, N] of half-size km around a point (as src/lib/geo.ts bboxAround). */
export function boxAround(lat: number, lon: number, halfKm: number): Box {
  const dLat = (halfKm / EARTH_RADIUS_KM) * (180 / Math.PI)
  const dLon = dLat / Math.max(0.01, Math.cos(lat * DEG))
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
}

/** Coordinates are shared rounded to 0.01° (src/ui/share/links.ts roundCoord). */
export const round2 = (v: number) => Math.round(v * 100) / 100

const f6 = (v: number) => v.toFixed(6)
const bboxPath = (b: Box) => `${f6(b[0])},${f6(b[1])},${f6(b[2])},${f6(b[3])}`

// ── The render ──────────────────────────────────────────────────────────────────────────────

/**
 * Sentinel-2 L2A digital-number offset: BOA_ADD_OFFSET is −1000 from processing baseline 04.00, i.e. for products
 * generated from 25 Jan 2022 on (Planetary Computer item ids end with the generation time). `baseline` (the item's
 * s2:processing_baseline), when known, decides.
 */
export function s2Offset(itemId: string, baseline?: string): number {
  if (baseline && /^\d{2}\.\d{2}$/.test(baseline)) return baseline >= '04.00' ? 1000 : 0
  const m = /_(\d{8})T\d{6}$/.exec(itemId)
  return m && m[1] < '20220125' ? 0 : 1000
}

/** Landsat Collection 2 L2 surface reflectance: ρ = DN × 2.75e-5 − 0.2. */
const LS_SCALE = 2.75e-5
const LS_OFFSET_DN = 0.2 / LS_SCALE

/**
 * Query string (after collection & item) for the encoded render: sqrt(reflectance) over [0, ENC_TOP_REFL] → 0…255,
 * Lanczos warp. An expression (not rescale + color_formula: PC rounds to 8 bits after `rescale`, before the formula).
 */
export function pcRenderQuery(collection: ToneCollection, itemId: string, baseline?: string): string {
  if (collection === 'sentinel-2-l2a') {
    const off = s2Offset(itemId, baseline)
    const top = Math.sqrt(ENC_TOP_REFL * 10_000)
    const expr = ['B04', 'B03', 'B02'].map((b) => `sqrt(where(${b}>${off},${b}-${off},0))`).join(';')
    return `assets=B04&assets=B03&assets=B02&asset_as_band=true&expression=${encodeURIComponent(expr)}&rescale=0,${round3(top)}&nodata=0&reproject=lanczos`
  }
  const off = round3(LS_OFFSET_DN)
  const top = Math.sqrt(ENC_TOP_REFL / LS_SCALE)
  const expr = ['red', 'green', 'blue'].map((b) => `sqrt(where(${b}>${off},${b}-${off},0))`).join(';')
  return `assets=red&assets=green&assets=blue&asset_as_band=true&expression=${encodeURIComponent(expr)}&rescale=0,${round3(top)}&reproject=lanczos`
}
const round3 = (v: number) => String(Math.round(v * 1000) / 1000)

/** A square crop of the encoded render. `fmt` jpg for display (≈1/7 of the PNG), png for a lossless download. */
export function pcCropUrlFor(collection: ToneCollection, itemId: string, box: Box, px: number, fmt: 'png' | 'jpg' = 'png', baseline?: string): string {
  return `${PC_DATA}/item/bbox/${bboxPath(box)}/${px}x${px}.${fmt}?collection=${collection}&item=${encodeURIComponent(itemId)}&${pcRenderQuery(collection, itemId, baseline)}`
}

// ── The mask (cloud classes around the rounded point) ───────────────────────────────────────

/** Side of the mask grid: 64 px over the photo's square (156 m / px for Sentinel-2, 234 m for Landsat). */
export const MASK_PX = 64

/** The mask's square: the photo's crop around the ROUNDED point. */
export function maskBox(collection: ToneCollection, lat: number, lon: number): Box {
  return boxAround(round2(lat), round2(lon), CROP_HALF_KM[collection])
}

/** Raw classification over the mask square (nearest resampling: class values stay exact), as numpy (.npy). */
export function maskUrl(collection: ToneCollection, itemId: string, lat: number, lon: number): string {
  const asset = collection === 'sentinel-2-l2a' ? 'SCL' : 'qa_pixel'
  return `${PC_DATA}/item/bbox/${bboxPath(maskBox(collection, lat, lon))}/${MASK_PX}x${MASK_PX}.npy?collection=${collection}&item=${encodeURIComponent(itemId)}&assets=${asset}`
}

// ── Which region a crop is toned from ───────────────────────────────────────────────────────

export interface TonePlan {
  collection: ToneCollection
  itemId: string
  /** The crop's own square */
  box: Box
  /** The rounded point the region and the mask are centred on */
  lat: number
  lon: number
  /** Measuring region (the card's square around the rounded point) */
  ref: Box
  maskUrl: string
  /** Ground metres per output pixel */
  metresPerPx: number
  /** Key of the shared curve for this capture at this place */
  key: string
  /** The crop is a JPEG (its 8-px compression grid is smoothed before sharpening, tone.ts deblock8) */
  jpeg: boolean
}

const PC_BBOX_RE = /^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\/(\d+)x(\d+)\.(png|jpg)\?(.*)$/

/**
 * The tone plan for a crop URL built by `pcCropUrlFor` (the encoded render), or null for any other image (GIBS,
 * an Earth Search thumbnail, an older render). Everything comes from the URL, so the app's loader, which only
 * sees URLs, and the server derive the same plan.
 */
export function tonePlanForUrl(url: string): TonePlan | null {
  const m = PC_BBOX_RE.exec(url)
  if (!m || !/(^|&)expression=/.test(m[8])) return null
  const q = new URLSearchParams(m[8])
  const collection = q.get('collection') ?? ''
  const itemId = q.get('item') ?? ''
  if (!isToneCollection(collection) || !itemId) return null
  const box: Box = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  const px = Number(m[5])
  if (!box.every(Number.isFinite) || !(box[2] > box[0]) || !(box[3] > box[1]) || !(px > 0)) return null
  const lat = round2((box[1] + box[3]) / 2)
  const lon = round2((box[0] + box[2]) / 2)
  const heightKm = ((box[3] - box[1]) * DEG) * EARTH_RADIUS_KM
  return {
    collection,
    itemId,
    box,
    lat,
    lon,
    ref: boxAround(lat, lon, REF_HALF_KM[collection]),
    maskUrl: maskUrl(collection, itemId, lat, lon),
    metresPerPx: (heightKm * 1000) / px,
    key: `${collection}|${itemId}|${lat.toFixed(2)},${lon.toFixed(2)}`,
    jpeg: m[7] === 'jpg',
  }
}

/** Crops this close to native resolution measure a curve worth sharing with the capture's other sizes. */
export const canShareCurve = (p: Pick<TonePlan, 'collection' | 'metresPerPx'>) => p.metresPerPx <= NATIVE_GSD_M[p.collection] * 1.6
