/**
 * Sentinel-1 radar images (Planetary Computer's `sentinel-1-rtc`: C-band backscatter, terrain-corrected, 10 m pixels
 * on a UTM grid): the crop URL every view asks for, and how to recognise one.
 *
 * Why it looks the way it does:
 *  - ON THE PLACE'S GRID, like the Sentinel-2 photos (api/_lib/toneRender.ts placeGrid: the place's UTM zone, 10 m
 *    pixel corners; the RTC scenes are delivered on exactly that lattice), so a scene in the place's zone is read as it
 *    is and every image of the place turns the same way.
 *  - 20 km at 1000 px: 20 m a pixel, Sentinel-1's own resolution (IW: 20 × 22 m; its 10 m pixels are a finer spacing,
 *    not finer detail). Each shown pixel is the mean of 2 × 2 archive pixels in linear power (`resampling=average`),
 *    which is also what calms the radar's speckle. A thumbnail averages its own larger blocks.
 *  - ENCODED, NOT SHOWN: backscatter spans five orders of magnitude, so Planetary Computer sends decibels over
 *    [−32.5, +5] dB as 8 bits (0.15 dB a step; anything at or below −30 dB, calm water, is 17), 0 meaning no data. The
 *    pixels worker gives each image its own contrast (./radarTone.ts) before anything shows it, as it tones every
 *    Sentinel-2 / Landsat photo: never put this URL straight into an <img>.
 *  - One polarisation: VV where the scene has it (nearly everywhere), else HH (polar ice).
 */
import type { LatLon } from '@/types'
import { boxAround, nativeBox, placeGrid } from '../../api/_lib/toneRender'
import { PC_DATA, sanitizeCrop, type CropOpts } from './endpoints'

export const RADAR_COLLECTION = 'sentinel-1-rtc'
/** Shown ground size of a pixel of the radar card (Sentinel-1 IW resolution), metres. */
export const RADAR_GSD_M = 20
/** Half side of the radar card, km (20 km: 1000 px of 20 m). */
export const RADAR_HALF_KM = 10
/** The archive's pixel spacing, metres. */
const RTC_SPACING_M = 10

/** Decibels at the bottom and top of the encoded range, and the floor everything quieter is lifted to. */
export const RADAR_DB_MIN = -32.5
export const RADAR_DB_MAX = 5
const RADAR_DB_FLOOR = -30

export type RadarPol = 'vv' | 'hh'

/** The render query (after collection & item): dB of one polarisation, 8-bit, averaged when shown smaller than read. */
function radarQuery(pol: RadarPol, resample: boolean): string {
  const expr = `where(${pol}>${10 ** (RADAR_DB_FLOOR / 10)},10*log10(${pol}),${RADAR_DB_FLOOR})`
  return `assets=${pol}&asset_as_band=true&expression=${encodeURIComponent(expr)}&rescale=${RADAR_DB_MIN},${RADAR_DB_MAX}${resample ? '&resampling=average' : ''}&reproject=average`
}

const f6 = (v: number) => v.toFixed(6)
const fm = (v: number) => String(Math.round(v * 100) / 100)

/**
 * A square radar crop of one RTC item centred on `place`: on the place's UTM grid (whole 10 m pixels), else (beyond
 * UTM's latitudes, or `geographic`) in lon/lat. Depends on the item, its polarisation, the place and the size only.
 */
export function radarCropUrl(itemId: string, pol: RadarPol, place: LatLon, opts: CropOpts): string {
  const { halfSizeKm, px } = sanitizeCrop(opts)
  const head = `${PC_DATA}/item/bbox`
  const tail = `collection=${RADAR_COLLECTION}&item=${encodeURIComponent(itemId)}`
  const grid = opts.geographic ? null : placeGrid('sentinel-2-l2a', place.lat, place.lon)
  if (grid) {
    const n = Math.max(1, Math.round((2 * halfSizeKm * 1000) / RTC_SPACING_M))
    const b = nativeBox(grid, place.lat, place.lon, n)
    return `${head}/${b.map(fm).join(',')}/${px}x${px}.png?${tail}&coord_crs=EPSG:${grid.epsg}&dst_crs=EPSG:${grid.epsg}&${radarQuery(pol, px !== n)}`
  }
  const b = boxAround(place.lat, place.lon, halfSizeKm)
  return `${head}/${b.map(f6).join(',')}/${px}x${px}.png?${tail}&${radarQuery(pol, true)}`
}

const RADAR_URL = /^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/[^?]+\.(png|jpg)\?collection=sentinel-1-rtc&.*expression=/

/** A radar crop built here: toned (./radarTone.ts) before anything shows it. */
export const isRadarUrl = (url: string) => RADAR_URL.test(url)
