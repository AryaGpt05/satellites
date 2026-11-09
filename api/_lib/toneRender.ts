/**
 * The Sentinel-2 / Landsat render every renderer asks Planetary Computer for, its cloud-mask request, and which
 * region a crop's tone is measured over (see ./tone.ts for the whole method). Only URL arithmetic, none of the pixel
 * code; the app reaches it through src/imagery/pcCrop.ts, loaded with the search (never by the first screen).
 * Self-contained but for ./utm.ts (no other imports): the browser bundle and the functions share both.
 *
 * Two geometries:
 *  - THE PLACE'S GRID (every Sentinel-2 / Landsat photo between 80° S and 84° N): the crop is asked for on the UTM
 *    grid of the place's zone (`coord_crs` = `dst_crs`; placeGrid: the zone of the place rounded to 0.01°, as MGRS
 *    draws it), its box a whole number of native pixels on that zone's pixel lattice (Sentinel-2's 10 m corners,
 *    Landsat's 30 m corners at 15 m). ONE grid per place, whatever scene a photo comes from, so every photo of a
 *    place is turned the same way (swiping the gallery never turns the ground) and the server can build the app's
 *    URL from the share alone. A scene ON that grid (nearly all: stac.ts dedupeCandidates prefers the tile of the
 *    place's zone) is copied as it is: no warp, no resampling at native size (Sentinel-2: 1000 px for 10 km), an
 *    exact 2× Lanczos for Landsat (500 native px shown at 1000); `reproject=lanczos` is then a no-op (measured:
 *    byte-identical). A scene of the neighbouring zone (a place near a zone edge that only it covers), or Landsat
 *    over Antarctica (polar stereographic), is warped onto the grid with Lanczos. Up is grid north, which differs
 *    from true north by the meridian convergence (utm.ts gridBearingOfNorthDeg: under 3° in a standard zone, up to 5.4°
 *    in south-west Norway's zone 32 and 6.0° in Svalbard's 12°-wide zones); the place is within
 *    half a native pixel of the centre (one pixel when it lies within a few metres of a 0.01° line, see nativeBox).
 *  - GEOGRAPHIC (lon/lat, EPSG:4326): places beyond UTM's latitudes, and the globe's decals, which are mapped onto
 *    the sphere in lon/lat: warped with Lanczos.
 * The URL says which (coord_crs), so a plan read back from a URL (tonePlanForUrl) knows its geometry. The cloud
 * mask is always geographic (maskUrl): one request per capture and place, whatever the crop's geometry.
 */
import { gridBearingOfNorthDeg, utmForward, utmInverse, utmZoneAt, utmZoneOf } from './utm.js'

export type ToneCollection = 'sentinel-2-l2a' | 'landsat-c2-l2'
/** [west, south, east, north]: degrees for a geographic crop, metres on the grid for a native one. */
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
 * 10 m for Sentinel-2, 15 m for Landsat), which the server's crop IS and the app's photo contains.
 */
export const REF_HALF_KM: Record<ToneCollection, number> = { 'sentinel-2-l2a': 3.15, 'landsat-c2-l2': 4.725 }

/**
 * Output side of the app's photo, px (src/ui/results/lib/captures.ts DETAILED_PX): Sentinel-2's own pixels, Landsat's
 * at 2×. A crop of the same capture with more pixels than this is a magnified view of that photo (the lightbox's
 * sharper layer, lib/photos hiResUrl).
 */
export const PHOTO_PX = 1000

/** Native pixels across the app's photo and the mask (10 km of 10 m, 15 km of 30 m). */
export const PHOTO_NATIVE_PX: Record<ToneCollection, number> = { 'sentinel-2-l2a': 1000, 'landsat-c2-l2': 500 }
/** Native pixels across the share card's square, the measuring region (6.3 km of 10 m, 9.45 km of 30 m). */
export const CARD_NATIVE_PX: Record<ToneCollection, number> = { 'sentinel-2-l2a': 630, 'landsat-c2-l2': 315 }

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
/** Grid coordinates are whole metres for every UTM scene (corners at multiples of 10 m, or 15 mod 30 m). */
const fm = (v: number) => String(Math.round(v * 100) / 100)
const gridPath = (b: Box) => `${fm(b[0])},${fm(b[1])},${fm(b[2])},${fm(b[3])}`

// ── The grids ───────────────────────────────────────────────────────────────────────────────

/** A pixel grid on a UTM zone: its CRS and where its pixel corners fall (placeGrid: the place's, as the archive delivers it). */
export interface NativeGrid {
  /** EPSG:326zz / 327zz */
  epsg: number
  /** Pixel size of the true-colour bands, metres */
  gsd: number
  /** Pixel corners lie at ox + k·gsd (eastings) and oy + k·gsd (northings), 0 ≤ ox, oy < gsd */
  ox: number
  oy: number
}

const mod = (v: number, m: number) => ((v % m) + m) % m

/**
 * A Sentinel-2 L2A scene's UTM CRS from its item id alone: the MGRS tile (T33UUU: zone 33, latitude band U, north)
 * names the zone and the hemisphere. Null for anything else.
 */
export function s2EpsgFromItemId(itemId: string): number | null {
  const m = /_T(\d{2})([C-HJ-NP-X])[A-Z]{2}_/.exec(itemId)
  if (!m) return null
  const zone = Number(m[1])
  if (!(zone >= 1 && zone <= 60)) return null
  return (m[2] >= 'N' ? 32600 : 32700) + zone
}

type StacAssets = Record<string, Record<string, unknown> | undefined> | undefined

/**
 * A scene's own CRS from its STAC item (`proj:code` / `proj:epsg` of the red band, else the item's), or null unless it
 * is a UTM zone (Landsat over Antarctica is polar stereographic, EPSG:3031). Which scene of an overflight to show
 * prefers one in the place's zone (sceneOnPlaceGrid: copied 1:1); the crop itself is always on the place's grid.
 */
export function sceneEpsgFromStac(collection: ToneCollection, properties: Record<string, unknown>, assets?: StacAssets): number | null {
  const band = assets?.[collection === 'sentinel-2-l2a' ? 'B04' : 'red']
  const code = band?.['proj:code'] ?? properties['proj:code']
  const epsg = typeof code === 'string' && /^EPSG:\d+$/.test(code) ? Number(code.slice(5)) : (band?.['proj:epsg'] ?? properties['proj:epsg'])
  return typeof epsg === 'number' && utmZoneOf(epsg) ? epsg : null
}

/** The UTM zone of a place rounded to 0.01° (MGRS's, utm.ts utmZoneAt), or null beyond UTM's latitudes. */
export const placeZone = (lat: number, lon: number): number | null => utmZoneAt(round2(lat), round2(lon))

/**
 * The grid every Sentinel-2 / Landsat photo of a place is cut on: the UTM zone of the place rounded to 0.01° (so the
 * app's photo around the exact place, its share card and the server's card around the rounded one share it), on the
 * collection's own pixel lattice there, as its scenes in that zone are delivered: Sentinel-2 on 10 m corners in
 * EPSG:326zz / 327zz by hemisphere (MGRS latitude bands), Landsat on 30 m corners at 15 m in EPSG:326zz even south of
 * the equator (Collection 2 uses north zones with negative northings). Null beyond 80° S / 84° N (lon/lat crops).
 */
export function placeGrid(collection: ToneCollection, lat: number, lon: number): NativeGrid | null {
  const zone = placeZone(lat, lon)
  if (zone === null) return null
  if (collection === 'sentinel-2-l2a') return { epsg: (round2(lat) >= 0 ? 32600 : 32700) + zone, gsd: 10, ox: 0, oy: 0 }
  return { epsg: 32600 + zone, gsd: 30, ox: 15, oy: 15 }
}

/** Whether a scene's own CRS is the place grid's zone (its crops are then copied 1:1, not warped). */
export function sceneOnPlaceGrid(sceneEpsg: number | undefined, lat: number, lon: number): boolean {
  const z = sceneEpsg === undefined ? null : utmZoneOf(sceneEpsg)
  return !!z && z.zone === placeZone(lat, lon)
}

/** Every crop's centre rounds to the same 0.01° point as the place it is centred on: the tone's key, mask and region. */
const sameRounded = (a: [number, number], lat: number, lon: number) => Math.round(a[0] * 100) === Math.round(lat * 100) && Math.round(a[1] * 100) === Math.round(lon * 100)

/**
 * The box of `n` native pixels on `grid` centred as near as the pixel corners allow on a place: [minx, miny, maxx,
 * maxy] in metres, its edges on pixel corners, so Planetary Computer copies whole pixels. The place lies within half
 * a pixel of the box's centre on each axis, except when that would put the centre across a 0.01° line from the
 * place (within a few metres of one): then the next corner over (≤ 1.5 px) keeps the crop's measuring region, mask
 * and curve those of the place (tonePlanForUrl reads them from the centre).
 */
export function nativeBox(grid: NativeGrid, lat: number, lon: number, n: number): Box {
  const { gsd, ox, oy } = grid
  const [x, y] = utmForward(grid.epsg, lat, lon)
  const fx = (x - ox) / gsd - n / 2 // west edge, in pixels
  const fy = (y - oy) / gsd + n / 2 // north edge
  const i0 = Math.round(fx)
  const j0 = Math.round(fy)
  const cands: [number, number][] = []
  for (const di of [0, -1, 1]) for (const dj of [0, -1, 1]) cands.push([i0 + di, j0 + dj])
  cands.sort((a, b) => (a[0] - fx) ** 2 + (a[1] - fy) ** 2 - ((b[0] - fx) ** 2 + (b[1] - fy) ** 2))
  const boxOf = ([i, j]: [number, number]): Box => [ox + i * gsd, oy + (j - n) * gsd, ox + (i + n) * gsd, oy + j * gsd]
  for (const c of cands) {
    const b = boxOf(c)
    if (sameRounded(nativeCentre(grid.epsg, b), lat, lon)) return b
  }
  return boxOf(cands[0])
}

/** The lat/lon of a box's centre on `epsg`'s grid. */
export const nativeCentre = (epsg: number, b: Box): [number, number] => utmInverse(epsg, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2)

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
 * Query string (after collection & item) for the encoded render: sqrt(reflectance) over [0, ENC_TOP_REFL] → 0…255.
 * An expression (not rescale + color_formula: PC rounds to 8 bits after `rescale`, before the formula). Any warp is
 * Lanczos (`reproject=lanczos`: the default nearest warp leaves stair-steps): a lon/lat crop is always warped; a crop
 * on the place's grid only when its scene lies in another CRS (a scene on that grid is read as it is, and the
 * parameter changes nothing: measured byte-identical with and without it).
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

/** A square crop of the encoded render in lon/lat. `fmt` jpg for display (≈1/7 of the PNG), png for a lossless download. */
export function pcCropUrlFor(collection: ToneCollection, itemId: string, box: Box, px: number, fmt: 'png' | 'jpg' = 'png', baseline?: string): string {
  return `${PC_DATA}/item/bbox/${bboxPath(box)}/${px}x${px}.${fmt}?collection=${collection}&item=${encodeURIComponent(itemId)}&${pcRenderQuery(collection, itemId, baseline)}`
}

/** The query parameters that put a bbox request on a UTM grid: the box is in its metres, and so is the answer. */
const gridQuery = (epsg: number) => `coord_crs=EPSG:${epsg}&dst_crs=EPSG:${epsg}`

/**
 * A square crop of the encoded render on a UTM grid: `box` from nativeBox (whole pixels of the grid). A scene on that
 * grid at `px` equal to the box's pixels is copied as it is; at any other size it is resampled on the same grid with
 * Lanczos (Landsat's exact 2× for display; thumbnails, which it averages down properly). A scene in another CRS is
 * warped onto it with Lanczos.
 */
export function pcNativeCropUrlFor(collection: ToneCollection, itemId: string, grid: NativeGrid, box: Box, px: number, fmt: 'png' | 'jpg' = 'png', baseline?: string): string {
  const n = Math.round((box[2] - box[0]) / grid.gsd)
  const resample = px === n ? '' : '&resampling=lanczos'
  return `${PC_DATA}/item/bbox/${gridPath(box)}/${px}x${px}.${fmt}?collection=${collection}&item=${encodeURIComponent(itemId)}&${gridQuery(grid.epsg)}&${pcRenderQuery(collection, itemId, baseline)}${resample}`
}

/**
 * The crop every renderer asks for, centred on a place: on the place's grid (placeGrid; `n` of its pixels across,
 * from `halfSizeKm`), else (beyond UTM's latitudes, or `geographic`: the globe's decals) in lon/lat. It depends on
 * the capture's collection and id and the place only, so the app, the share card and the server build the same URL
 * for the same capture, place and size (R3-1) with nothing else to look up.
 */
export function pcCropUrlAt(
  collection: ToneCollection,
  itemId: string,
  lat: number,
  lon: number,
  halfSizeKm: number,
  px: number,
  fmt: 'png' | 'jpg' = 'png',
  geographic = false,
): string {
  const grid = geographic ? null : placeGrid(collection, lat, lon)
  if (grid) {
    const n = Math.max(1, Math.round((2 * halfSizeKm * 1000) / grid.gsd))
    return pcNativeCropUrlFor(collection, itemId, grid, nativeBox(grid, lat, lon, n), px, fmt)
  }
  return pcCropUrlFor(collection, itemId, boxAround(lat, lon, halfSizeKm), px, fmt)
}

// ── The mask (cloud classes around the rounded point) ───────────────────────────────────────

/** Side of the mask grid: 64 px over the photo's square (156 m / px for Sentinel-2, 234 m for Landsat). */
export const MASK_PX = 64

/** The mask's square: the photo's crop around the ROUNDED point. */
export function maskBox(collection: ToneCollection, lat: number, lon: number): Box {
  return boxAround(round2(lat), round2(lon), CROP_HALF_KM[collection])
}

const maskAsset = (collection: ToneCollection) => (collection === 'sentinel-2-l2a' ? 'SCL' : 'qa_pixel')

/**
 * Raw classification over the mask square (nearest resampling: class values stay exact), as numpy (.npy). Always
 * lon/lat, whatever the geometry of the capture's crops: Planetary Computer warps it (each cell takes the class at
 * its centre), where a read on the scene's own grid decimates the 20 m / 30 m classes without a warp and samples
 * each cell near its north-west corner (measured: ½ cell, ~78 m off for Sentinel-2, against the COG). The curve, the
 * spot check and the clear fraction read it through lat/lon from crops on a UTM grid (tone.ts toMaskCrs).
 */
export function maskUrl(collection: ToneCollection, itemId: string, lat: number, lon: number): string {
  return `${PC_DATA}/item/bbox/${bboxPath(maskBox(collection, lat, lon))}/${MASK_PX}x${MASK_PX}.npy?collection=${collection}&item=${encodeURIComponent(itemId)}&assets=${maskAsset(collection)}`
}

// ── Which region a crop is toned from ───────────────────────────────────────────────────────

export interface TonePlan {
  collection: ToneCollection
  itemId: string
  /** The crop's own square, in `crs` */
  box: Box
  /** 4326 (box in degrees, row 0 north) or the scene's UTM EPSG (box in grid metres, row 0 grid north) */
  crs: number
  /** The rounded point the region and the mask are centred on */
  lat: number
  lon: number
  /** Measuring region (the card's square around the rounded point), in `crs` */
  ref: Box
  maskUrl: string
  /** Output side, px */
  px: number
  /** Ground metres per output pixel */
  metresPerPx: number
  /** Key of the shared curve for this capture at this place */
  key: string
  /** The crop is a JPEG (its 8-px compression grid is smoothed before sharpening, tone.ts deblock8) */
  jpeg: boolean
}

const PC_BBOX_RE = /^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\/(\d+)x(\d+)\.(png|jpg)\?(.*)$/

/** The UTM EPSG a bbox request's box and answer are in, 4326 for lon/lat, or null for a mix we never build. */
export function crsOfQuery(q: URLSearchParams): number | null {
  const coord = q.get('coord_crs')
  const dst = q.get('dst_crs')
  if (coord === null && dst === null) return 4326
  const m = /^EPSG:(\d+)$/.exec(coord ?? '')
  if (!m || dst !== coord || !utmZoneOf(Number(m[1]))) return null
  return Number(m[1])
}

/** The scene grid a native box was cut from: its corners lie on the grid's pixel corners. */
export const gridOfBox = (collection: ToneCollection, epsg: number, b: Box): NativeGrid => {
  const gsd = NATIVE_GSD_M[collection]
  return { epsg, gsd, ox: mod(Math.round(b[0] * 100) / 100, gsd), oy: mod(Math.round(b[3] * 100) / 100, gsd) }
}

/** Curve key: one per capture and rounded place. */
const planKey = (collection: ToneCollection, itemId: string, lat: number, lon: number) => `${collection}|${itemId}|${lat.toFixed(2)},${lon.toFixed(2)}`

/**
 * The tone plan for a crop URL built by `pcCropUrlFor` / `pcNativeCropUrlFor` (the encoded render), or null for any
 * other image (GIBS, an Earth Search thumbnail, an older render). Everything comes from the URL, so the app's
 * loader, which only sees URLs, and the server derive the same plan.
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
  const crs = crsOfQuery(q)
  if (crs === null) return null
  const jpeg = m[7] === 'jpg'
  if (crs !== 4326) {
    const grid = gridOfBox(collection, crs, box)
    const [clat, clon] = nativeCentre(crs, box)
    const lat = round2(clat)
    const lon = round2(clon)
    return {
      collection,
      itemId,
      box,
      crs,
      lat,
      lon,
      ref: nativeBox(grid, lat, lon, CARD_NATIVE_PX[collection]),
      maskUrl: maskUrl(collection, itemId, lat, lon),
      px,
      metresPerPx: (box[2] - box[0]) / px,
      key: planKey(collection, itemId, lat, lon),
      jpeg,
    }
  }
  const lat = round2((box[1] + box[3]) / 2)
  const lon = round2((box[0] + box[2]) / 2)
  const heightKm = (box[3] - box[1]) * DEG * EARTH_RADIUS_KM
  return {
    collection,
    itemId,
    box,
    crs,
    lat,
    lon,
    ref: boxAround(lat, lon, REF_HALF_KM[collection]),
    maskUrl: maskUrl(collection, itemId, lat, lon),
    px,
    metresPerPx: (heightKm * 1000) / px,
    key: planKey(collection, itemId, lat, lon),
    jpeg,
  }
}

/** Crops this close to native resolution measure a curve worth sharing with the capture's other sizes. */
export const canShareCurve = (p: Pick<TonePlan, 'collection' | 'metresPerPx'>) => p.metresPerPx <= NATIVE_GSD_M[p.collection] * 1.6

/**
 * A magnified view of the app's photo (more pixels than PHOTO_PX, near native or finer: the lightbox's sharper layer):
 * it crossfades in over the photo, so it is toned with the very curve the photo was shown with, never one of its own.
 */
export const isMagnifiedView = (p: Pick<TonePlan, 'collection' | 'metresPerPx' | 'px'>) => p.px > PHOTO_PX && canShareCurve(p)

// ── Where a place sits in a crop ────────────────────────────────────────────────────────────

/**
 * Where a lat/lon falls in a square crop URL built here, as fractions of its width and height from the top-left
 * (0.5, 0.5 = the centre), or null for any other URL. Native crops: through the grid (so the reticle's error is
 * measurable); geographic: linear in lon/lat.
 */
export function placeInCrop(url: string, lat: number, lon: number): { fx: number; fy: number } | null {
  const m = PC_BBOX_RE.exec(url)
  if (!m) return null
  const crs = crsOfQuery(new URLSearchParams(m[8]))
  if (crs === null) return null
  const b = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  const [x, y] = crs === 4326 ? [lon, lat] : utmForward(crs, lat, lon)
  return { fx: (x - b[0]) / (b[2] - b[0]), fy: (b[3] - y) / (b[3] - b[1]) }
}

/**
 * Which way true north points in a crop, degrees clockwise from the picture's up: the meridian convergence at its
 * centre for a native crop (up is grid north; within ±3° in a standard UTM zone, ±5.4° in Norway's zone 32, ±6.0° in
 * Svalbard's), 0 for a geographic one or any other image.
 * A compass bearing drawn on the picture (the satellite's heading, the pushbroom's sweep) turns by this.
 */
export function northInCropDeg(url: string): number {
  const m = PC_BBOX_RE.exec(url)
  if (!m) return 0
  const crs = crsOfQuery(new URLSearchParams(m[8]))
  if (crs === null || crs === 4326) return 0
  const b: Box = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  const [lat, lon] = nativeCentre(crs, b)
  return gridBearingOfNorthDeg(crs, lat, lon)
}

/** The CRS a crop URL built here is drawn in (4326 or the scene's UTM EPSG), or null for any other URL. */
export function cropCrs(url: string): number | null {
  const m = PC_BBOX_RE.exec(url)
  return m ? crsOfQuery(new URLSearchParams(m[8])) : null
}
