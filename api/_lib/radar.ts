/**
 * Sentinel-1 radar images (Planetary Computer's `sentinel-1-rtc`: C-band backscatter, terrain-corrected, 10 m pixels
 * on a UTM grid): the crop URL every renderer asks for, and the tone that makes it a picture. Shared by the app (through
 * src/imagery/radar.ts, its pixels worker) and the server's share cards (./imagery.ts), so a radar card shows the very
 * pixels the app showed, as ./toneRender.ts and ./tone.ts do for Sentinel-2 and Landsat. Self-contained but for
 * ./toneRender.ts (the place's grid).
 *
 * Why it looks the way it does:
 *  - ON THE PLACE'S GRID, like the Sentinel-2 photos (toneRender placeGrid: the place's UTM zone, 10 m pixel corners;
 *    the RTC scenes are delivered on exactly that lattice), so a scene in the place's zone is read as it is and every
 *    image of the place turns the same way.
 *  - 20 m a shown pixel (the app's card: 20 km at 1000 px), Sentinel-1's own resolution (IW: 20 × 22 m; its 10 m
 *    pixels are a finer spacing, not finer detail). Each shown pixel is the mean of the archive's pixels under it in
 *    linear power (`resampling=average`), which is also what calms the radar's speckle.
 *  - ENCODED, NOT SHOWN: backscatter spans five orders of magnitude, so Planetary Computer sends decibels over
 *    [−32.5, +5] dB as 8 bits (0.15 dB a step; anything at or below −30 dB, calm water, is 17), 0 meaning no data.
 *    Every renderer then gives each image its own contrast (toneRadar) before showing it.
 *  - One polarisation: VV where the scene has it (nearly everywhere), else HH (polar ice). A share keeps only the item
 *    id, which names it (radarPolOfItemId).
 *
 * The tone: what a radar sees varies far more from place to place than sunlight does (calm water is ~−25 dB, fields
 * −15, forest −8, a city's walls and corners above 0), so one fixed scale would leave a desert grey and a city blown
 * out. The stretch runs, in decibels, from the 1st to the 99.6th percentile of the image's data (bright points may
 * clip; they are corners and ships), never over less than 16 dB, so a uniform scene (open sea) stays calm instead of
 * being stretched into speckle. A slight gamma (1.15) keeps the dark ground dark. The ramp is the site's own: ink-2 in
 * the shadows (not darker: calm water stays a deep slate, never the black that means no data, which the globe's decal
 * keys out), ice (the design's one colour for radar) faintly in the mid-tones, a cool off-white at the top, never pure
 * white. Radar has no colour; the tint only says "this is not a photograph", and the brightness is the backscatter,
 * as measured. No data stays (0, 0, 0), as in every photo.
 */
import { boxAround, nativeBox, placeGrid } from './toneRender.js'

const PC_DATA = 'https://planetarycomputer.microsoft.com/api/data/v1'
export const RADAR_COLLECTION = 'sentinel-1-rtc'
/** Shown ground size of a pixel of the radar card (Sentinel-1 IW resolution), metres. */
export const RADAR_GSD_M = 20
/** Half side of the app's radar card, km (20 km: 1000 px of 20 m). */
export const RADAR_HALF_KM = 10
/** The archive's pixel spacing, metres. */
const RTC_SPACING_M = 10

/** Decibels at the bottom and top of the encoded range, and the floor everything quieter is lifted to. */
export const RADAR_DB_MIN = -32.5
export const RADAR_DB_MAX = 5
const RADAR_DB_FLOOR = -30

export type RadarPol = 'vv' | 'hh'

/** A Planetary Computer RTC item id: S1D_IW_GRDH_1SDV_20261109T051629_20261109T051654_005386_00A455_rtc. */
export const RADAR_ITEM_RE = /^S1[A-Z]_(IW|EW|SM)_GRD[HM]_1S[DS][VH]_\d{8}T\d{6}_\d{8}T\d{6}_\d{6}_[0-9A-F]{6}_rtc$/

/** The polarisation a scene's crops use, from its item id (1SDV / 1SSV: VV; 1SDH / 1SSH: HH), or null for another id. */
export function radarPolOfItemId(itemId: string): RadarPol | null {
  if (!RADAR_ITEM_RE.test(itemId)) return null
  return /_1S[DS]V_/.test(itemId) ? 'vv' : 'hh'
}

/** The render query (after collection & item): dB of one polarisation, 8-bit, averaged when shown smaller than read. */
function radarQuery(pol: RadarPol, resample: boolean): string {
  const expr = `where(${pol}>${10 ** (RADAR_DB_FLOOR / 10)},10*log10(${pol}),${RADAR_DB_FLOOR})`
  return `assets=${pol}&asset_as_band=true&expression=${encodeURIComponent(expr)}&rescale=${RADAR_DB_MIN},${RADAR_DB_MAX}${resample ? '&resampling=average' : ''}&reproject=average`
}

const f6 = (v: number) => v.toFixed(6)
const fm = (v: number) => String(Math.round(v * 100) / 100)

/**
 * A square radar crop of one RTC item centred on a place: on the place's UTM grid (whole 10 m pixels), else (beyond
 * UTM's latitudes, or `geographic`: the globe's decals) in lon/lat. Depends on the item, its polarisation, the place
 * and the size only, so the app and the server build the same URL for the same card.
 */
export function radarCropUrlAt(
  itemId: string,
  pol: RadarPol,
  lat: number,
  lon: number,
  halfSizeKm: number,
  px: number,
  fmt: 'png' | 'jpg' = 'png',
  geographic = false,
): string {
  const head = `${PC_DATA}/item/bbox`
  const tail = `collection=${RADAR_COLLECTION}&item=${encodeURIComponent(itemId)}`
  const grid = geographic ? null : placeGrid('sentinel-2-l2a', lat, lon)
  if (grid) {
    const n = Math.max(1, Math.round((2 * halfSizeKm * 1000) / RTC_SPACING_M))
    const b = nativeBox(grid, lat, lon, n)
    return `${head}/${b.map(fm).join(',')}/${px}x${px}.${fmt}?${tail}&coord_crs=EPSG:${grid.epsg}&dst_crs=EPSG:${grid.epsg}&${radarQuery(pol, px !== n)}`
  }
  const b = boxAround(lat, lon, halfSizeKm)
  return `${head}/${b.map(f6).join(',')}/${px}x${px}.${fmt}?${tail}&${radarQuery(pol, true)}`
}

const RADAR_URL = /^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/[^?]+\.(png|jpg)\?collection=sentinel-1-rtc&.*expression=/

/** A radar crop built here: toned (toneRadar) before anything shows it. */
export const isRadarUrl = (url: string) => RADAR_URL.test(url)

// ── The tone ────────────────────────────────────────────────────────────────────────────────

/** Encoded values below this are no data (0, plus a JPEG's ringing at a scene edge); data starts at 17 (−30 dB). */
const DATA_MIN = 12
const LOW_PCT = 0.01
const HIGH_PCT = 0.996
const MIN_SPAN_DB = 16
const GAMMA = 1.15
const DB_PER_STEP = (RADAR_DB_MAX - RADAR_DB_MIN) / 255

type Rgb = [number, number, number]
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const grey = (v: number): Rgb => [v * 255, v * 255, v * 255]

/** The design's tokens the ramp is built from (src/ui/system/palette.ts ink2 and ice; a test keeps them in step). */
export const RADAR_INK: Rgb = [0x14, 0x17, 0x1c]
export const RADAR_ICE: Rgb = [0xa9, 0xc7, 0xd3]

/** The ramp's stops: ink-2, a mid-grey a quarter of the way to ice, an off-white an eighth of the way. */
const STOPS: [number, Rgb][] = [
  [0, RADAR_INK],
  [0.6, mix(grey(0.53), RADAR_ICE, 0.25)],
  [1, mix(grey(0.93), RADAR_ICE, 0.12)],
]

function rampAt(t: number): Rgb {
  for (let i = 1; i < STOPS.length; i++) {
    const [x1, c1] = STOPS[i]
    const [x0, c0] = STOPS[i - 1]
    if (t <= x1) return mix(c0, c1, (t - x0) / (x1 - x0))
  }
  return STOPS[STOPS.length - 1][1]
}

/** The encoded value at a share `q` of the data, from its histogram. */
function quantile(hist: Uint32Array, total: number, q: number): number {
  const want = q * total
  let seen = 0
  for (let v = DATA_MIN; v < 256; v++) {
    seen += hist[v]
    if (seen >= want) return v
  }
  return 255
}

/**
 * The stretch of one image, in encoded steps: [low, high], the data's 1st and 99.6th percentiles widened about their
 * middle to at least 16 dB. Null when the image holds no data.
 */
export function radarStretch(hist: Uint32Array): [number, number] | null {
  let total = 0
  for (let v = DATA_MIN; v < 256; v++) total += hist[v]
  if (!total) return null
  let lo = quantile(hist, total, LOW_PCT)
  let hi = quantile(hist, total, HIGH_PCT)
  const minSpan = MIN_SPAN_DB / DB_PER_STEP
  if (hi - lo < minSpan) {
    const mid = quantile(hist, total, 0.5)
    lo = Math.min(lo, mid - minSpan / 2)
    hi = Math.max(hi, mid + minSpan / 2)
  }
  return [lo, hi]
}

/**
 * Tone a decoded radar crop in place (RGBA; the encoded value in the red channel, as a grey JPEG or PNG decodes).
 * Returns the share of its pixels that hold data (0 when none: the caller then has nothing to show).
 */
export function toneRadar(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): number {
  const n = width * height
  if (rgba.length < n * 4) throw new Error('size')
  const hist = new Uint32Array(256)
  for (let o = 0; o < n * 4; o += 4) hist[rgba[o]]++
  const stretch = radarStretch(hist)
  const lut = new Uint8Array(256 * 3)
  if (stretch) {
    const [lo, hi] = stretch
    for (let v = DATA_MIN; v < 256; v++) {
      const t = Math.pow(Math.min(1, Math.max(0, (v - lo) / (hi - lo))), GAMMA)
      const [r, g, b] = rampAt(t)
      // Never (0, 0, 0): that is the mark of no data.
      lut[v * 3] = Math.max(1, Math.round(r))
      lut[v * 3 + 1] = Math.max(1, Math.round(g))
      lut[v * 3 + 2] = Math.max(1, Math.round(b))
    }
  }
  let data = 0
  for (let o = 0; o < n * 4; o += 4) {
    const v = rgba[o]
    rgba[o] = lut[v * 3]
    rgba[o + 1] = lut[v * 3 + 1]
    rgba[o + 2] = lut[v * 3 + 2]
    rgba[o + 3] = 255
    if (v >= DATA_MIN) data++
  }
  return stretch ? data / n : 0
}
