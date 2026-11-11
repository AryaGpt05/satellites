/**
 * Closest look (owner requests B1 + D1, superseding decision #1's "clearest first"): the photo the summary
 * leads with, among the window's own photos. The full order (and the clear cover from before the window,
 * which has no pass) lives in ./photos.ts; this is its first window photo:
 *
 *   detailed  the most zoomed-in CLEAR Sentinel-2 / Landsat capture (smallest gsd, clearest spot, newest);
 *             if every one is clouded, the least cloudy (honestly labelled "Clouded over")
 *   mosaic    else the sharpest weather mosaic (VIIRS / MODIS, 250–375 m): well lit, then newest
 *   geo       else the lead geostationary watcher's latest frame (GOES / Himawari / Meteosat)
 *   null      else nothing: the summary says why
 *
 * Pure: unit-tested in lib.test.ts; the controller calls it (via bestLookImageUrl) to preload the hero.
 */
import type { Capture, GeoWatcher, Pass, Report, SpotCloud } from '@/types'
import { isCloudedOver } from '@/lib/clarity'
import { orderPhotos, windowCover } from './photos'

export type BestLook =
  | { kind: 'detailed' | 'mosaic'; pass: Pass; capture: Capture }
  | { kind: 'geo'; watcher: GeoWatcher }

/** Primary clarity class of a capture's spot classification. */
const SPOT_CLASS: Record<SpotCloud, number> = { clear: 0, cirrus: 0, unknown: 1, shadow: 2, cloud: 3 }

/** Scene cloud cover ≥ this (or cloud at the spot) means the picture is mostly cloud (src/lib/clarity.ts). */
export { CLOUDED_PCT } from '@/lib/clarity'

/** The capture shows mostly cloud: label it honestly, never as a bright unexplained square (decision #2). */
export function isClouded(c: Pick<Capture, 'spot' | 'cloudCoverPct'>): boolean {
  return isCloudedOver(c)
}

/** Comparator for imaged passes: clearest first (see the rank above). */
export function byClarity(a: { pass: Pass; capture?: Capture }, b: { pass: Pass; capture?: Capture }): number {
  const ca = a.capture
  const cb = b.capture
  const sa = SPOT_CLASS[ca?.spot ?? 'unknown']
  const sb = SPOT_CLASS[cb?.spot ?? 'unknown']
  if (sa !== sb) return sa - sb
  const ba = Math.floor((ca?.cloudCoverPct ?? 50) / 10)
  const bb = Math.floor((cb?.cloudCoverPct ?? 50) / 10)
  if (ba !== bb) return ba - bb
  const cirA = ca?.spot === 'cirrus' ? 1 : 0
  const cirB = cb?.spot === 'cirrus' ? 1 : 0
  if (cirA !== cirB) return cirA - cirB
  return b.pass.tClosest - a.pass.tClosest
}

export function pickBestLook(report: Pick<Report, 'passes' | 'captures' | 'geo'>): BestLook | null {
  const { photos } = orderPhotos({ passes: report.passes, captures: report.captures })
  const cover = windowCover(photos)
  if (cover?.photo.pass) return { kind: cover.photo.kind, pass: cover.photo.pass, capture: cover.photo.capture }
  const watcher = report.geo.find((g) => !!g.frames)
  if (watcher) return { kind: 'geo', watcher }
  return null
}
