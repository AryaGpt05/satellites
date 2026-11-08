/**
 * Best look (decision #1): the single clearest real picture of the place in a report.
 *
 *   detailed  Sentinel-2 / Landsat captures on imaged passes, ranked by clarity (below)
 *   mosaic    else the best daylight weather mosaic (VIIRS / MODIS, 250–375 m)
 *   geo       else the lead geostationary watcher's latest frame (GOES / Himawari)
 *   null      else nothing: the summary says why
 *
 * Clarity rank (also the order of the PHOTOGRAPHED list, decision #2):
 *   1. the pixel at your spot: clear or thin cirrus < unknown < shadow < cloud. Thin cirrus (SCL 10)
 *      often fires falsely over bright cities, so it ranks WITH clear and only loses a tie.
 *   2. scene cloud cover in 10 % buckets (lower first; unknown counts as 50 %)
 *   3. clear before cirrus
 *   4. more recent first
 *
 * Pure: unit-tested in lib.test.ts; the controller calls it to preload the hero during computing.
 */
import type { Capture, GeoWatcher, Pass, Report, SpotCloud } from '@/types'
import { captureFor, isDetailed } from './captures'

export type BestLook =
  | { kind: 'detailed' | 'mosaic'; pass: Pass; capture: Capture }
  | { kind: 'geo'; watcher: GeoWatcher }

/** Primary clarity class of a capture's spot classification. */
const SPOT_CLASS: Record<SpotCloud, number> = { clear: 0, cirrus: 0, unknown: 1, shadow: 2, cloud: 3 }

/** Scene cloud cover ≥ this (or cloud at the spot) means the picture is mostly cloud. */
export const CLOUDED_PCT = 70

/** The capture shows mostly cloud: label it honestly, never as a bright unexplained square (decision #2). */
export function isClouded(c: Pick<Capture, 'spot' | 'cloudCoverPct'>): boolean {
  return c.spot === 'cloud' || (c.cloudCoverPct ?? 0) >= CLOUDED_PCT
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

/** Sun high enough that a daily true-colour mosaic shows the ground, not twilight. */
const MOSAIC_MIN_SUN_DEG = 10

export function pickBestLook(report: Pick<Report, 'passes' | 'captures' | 'geo'>): BestLook | null {
  const imaged: { pass: Pass; capture: Capture }[] = []
  for (const pass of report.passes) {
    if (pass.verdict !== 'imaged') continue
    const capture = captureFor(report, pass)
    if (capture) imaged.push({ pass, capture })
  }
  const detailed = imaged.filter((x) => isDetailed(x.capture)).sort(byClarity)
  if (detailed[0]) return { kind: 'detailed', ...detailed[0] }

  // Weather mosaics carry no per-pixel cloud: prefer a well-lit day, then the most recent.
  const mosaics = imaged
    .filter((x) => !isDetailed(x.capture))
    .sort(
      (a, b) =>
        Number(b.pass.sunElevationDeg >= MOSAIC_MIN_SUN_DEG) - Number(a.pass.sunElevationDeg >= MOSAIC_MIN_SUN_DEG) ||
        b.pass.tClosest - a.pass.tClosest,
    )
  if (mosaics[0]) return { kind: 'mosaic', ...mosaics[0] }

  const watcher = report.geo.find((g) => !!g.gibs)
  if (watcher) return { kind: 'geo', watcher }
  return null
}
