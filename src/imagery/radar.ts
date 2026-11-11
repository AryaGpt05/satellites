/**
 * Sentinel-1 radar images in the app: the crop URL for a capture at a place (api/_lib/radar.ts builds it, shared with
 * the server's share cards; see there for why the crop, the encoding and the tone are what they are). Never put this
 * URL straight into an <img>: the pixels worker tones it first (pixels.ts, through radarTone.ts).
 */
import type { LatLon } from '@/types'
import { radarCropUrlAt, type RadarPol } from '../../api/_lib/radar'
import { sanitizeCrop, type CropOpts } from './endpoints'

export { RADAR_COLLECTION, RADAR_DB_MAX, RADAR_DB_MIN, RADAR_GSD_M, RADAR_HALF_KM, isRadarUrl, radarPolOfItemId, type RadarPol } from '../../api/_lib/radar'

/** A square radar crop of one RTC item centred on `place` (on the place's grid; lon/lat when `geographic`). */
export function radarCropUrl(itemId: string, pol: RadarPol, place: LatLon, opts: CropOpts): string {
  const { halfSizeKm, px } = sanitizeCrop(opts)
  return radarCropUrlAt(itemId, pol, place.lat, place.lon, halfSizeKm, px, 'png', !!opts.geographic)
}
