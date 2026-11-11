/**
 * Capture helpers: which image belongs to a pass, how big a crop to ask for, and how to label it
 * honestly (a 375 m daily mosaic is not a 10 m photograph).
 */
import type { Capture, CaptureCollection, Pass, Report } from '@/types'

/** The capture attached to a pass, if any. */
export function captureFor(report: Pick<Report, 'captures'>, pass: Pick<Pass, 'captureId'>): Capture | undefined {
  if (!pass.captureId) return undefined
  return report.captures.find((c) => c.id === pass.captureId)
}

export const isDailyMosaic = (c: Pick<Capture, 'provider' | 'collection'>) =>
  c.provider === 'gibs' && /^gibs-(viirs|modis)-/.test(c.collection)

/** "Detailed" = per-scene archive imagery (Sentinel-2, Landsat), as opposed to weather mosaics. */
export const isDetailed = (c: Pick<Capture, 'provider' | 'collection'>) => !isDailyMosaic(c) && c.provider !== 'gibs'

export interface CropSpec {
  halfSizeKm: number
  px: number
}

/** Rendered size of a weather mosaic's crop (square). 1024 lines → the reveal counts LINE 0000 → 1024. */
export const CROP_PX = 1024
/**
 * Rendered size of a Sentinel-2 / Landsat photo: 1000 px, i.e. exactly the scene's own pixels for Sentinel-2
 * (10 km of 10 m, copied as they are on its grid) and exactly 2× for Landsat (15 km of 30 m: 500 native pixels,
 * Lanczos on the same grid, no warp). See api/_lib/toneRender.ts nativeBox.
 */
export const DETAILED_PX = 1000

/**
 * Crop size per collection, chosen so the picture reads at its native scale:
 *  - Sentinel-2 (10 m): 10 km square = 1000 native pixels at 1000 px
 *  - Landsat (30 m): 15 km square (500 native pixels, an exact 2× on their own grid, still crisp)
 *  - VIIRS / MODIS daily mosaics: 240 km square, enough to see the weather system over the place
 *  - geostationary frames: 800 km square
 * `px` defaults to the collection's own size (DETAILED_PX for Sentinel-2 / Landsat, CROP_PX otherwise).
 */
export function cropSpec(collection: CaptureCollection, px?: number): CropSpec {
  switch (collection) {
    case 'sentinel-2-l2a':
      return { halfSizeKm: 5, px: px ?? DETAILED_PX }
    case 'landsat-c2-l2':
      return { halfSizeKm: 7.5, px: px ?? DETAILED_PX }
    case 'gibs-goes-east':
    case 'gibs-goes-west':
    case 'gibs-himawari':
      return { halfSizeKm: 400, px: px ?? CROP_PX }
    default:
      return { halfSizeKm: 120, px: px ?? CROP_PX }
  }
}

const PC_BBOX = /^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/[^?]+\.png\?/

/**
 * URL to display. Planetary Computer renders the same crop as JPEG at ~1/7 of the PNG size
 * (1024 px: 380 KB vs 2.6 MB, and faster), which matters on phones. Other providers unchanged.
 */
export function displayUrl(capture: Pick<Capture, 'cropUrl'>, spec: CropSpec): string {
  const url = capture.cropUrl(spec)
  return PC_BBOX.test(url) ? url.replace(/\.png\?/, '.jpg?') : url
}

/** URL for "Download image": the lossless render where the provider offers one. */
export function downloadUrl(capture: Pick<Capture, 'cropUrl'>, spec: CropSpec): string {
  return capture.cropUrl(spec)
}

/** Instrument names for captions. */
export function sensorName(c: Pick<Capture, 'collection' | 'platform'>): string {
  switch (c.collection) {
    case 'sentinel-2-l2a':
      return 'MSI'
    case 'landsat-c2-l2':
      return c.platform === 'landsat-9' ? 'OLI-2' : 'OLI'
    case 'gibs-viirs-noaa20':
    case 'gibs-viirs-noaa21':
    case 'gibs-viirs-snpp':
      return 'VIIRS'
    case 'gibs-modis-terra':
    case 'gibs-modis-aqua':
      return 'MODIS'
    case 'gibs-goes-east':
    case 'gibs-goes-west':
      return 'ABI'
    case 'gibs-himawari':
      return 'AHI'
    case 'sentinel-1-rtc':
      return 'C-SAR'
  }
}

/** Product line for captions: "Sentinel-2 L2A · 10 m" / "Daily mosaic · 375 m". */
export function productLabel(c: Pick<Capture, 'collection' | 'provider' | 'gsdM'>): string {
  if (isDailyMosaic(c)) return `Daily mosaic · ${Math.round(c.gsdM)} m`
  switch (c.collection) {
    case 'sentinel-2-l2a':
      return `Sentinel-2 L2A · ${Math.round(c.gsdM)} m`
    case 'landsat-c2-l2':
      return `Landsat C2 L2 · ${Math.round(c.gsdM)} m`
    default:
      return `${Math.round(c.gsdM)} m`
  }
}

/** Archive name for the "View source" link. */
export function archiveName(c: Pick<Capture, 'provider'>): string {
  switch (c.provider) {
    case 'planetary-computer':
      return 'Planetary Computer'
    case 'earth-search':
      return 'Earth Search'
    case 'gibs':
      return 'NASA Worldview'
  }
}

/** A "nice" scale-bar length (km) about a fifth of the crop width. */
export function scaleBarKm(widthKm: number): number {
  const target = widthKm / 5
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]
  let best = steps[0]
  for (const s of steps) if (s <= target) best = s
  return best
}

/** Filename-safe slug. */
export function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}
