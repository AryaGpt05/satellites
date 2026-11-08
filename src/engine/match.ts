/**
 * Matching archive captures to predicted passes. Pure functions (no network), unit-tested.
 *
 * Time semantics of `Capture.datetime` differ by archive:
 *  - Landsat (PC):        scene-centre time, within seconds of our closest approach.
 *  - Sentinel-2 (PC/E84): the DATATAKE start, which can precede the overflight of the place by many
 *                         minutes (measured: 16:14:21 archive vs 16:21:14 SGP4 over Waterloo).
 *  - GIBS daily mosaics:  the imagery module stamps them with the pass they were derived from.
 * So a scene matches the pass of the same satellite whose closest approach lies in
 * [datetime − 10 min, datetime + 60 min]. Sentinel-2 only images on the sunlit half of its 100-minute
 * orbit, so a datatake cannot start much more than 50 min before it reaches any place; and one satellite
 * cannot pass the same place twice within ~95 min (one orbit), so the window is unambiguous.
 */
import type { Capture, Pass } from '@/types'
import { noradForGibsCollection, noradForPlatform } from './profiles'

export const MATCH_BEFORE_MS = 10 * 60_000
export const MATCH_AFTER_MS = 60 * 60_000

export function captureNorad(c: Capture): number | undefined {
  return c.norad ?? noradForPlatform(c.platform) ?? noradForGibsCollection(c.collection)
}

/** The pass a capture belongs to, if any. */
export function passForCapture(c: Capture, passes: readonly Pass[]): Pass | undefined {
  const norad = captureNorad(c)
  if (norad === undefined) return undefined
  let best: Pass | undefined
  for (const p of passes) {
    if (p.norad !== norad) continue
    const dt = p.tClosest - c.datetime
    if (dt < -MATCH_BEFORE_MS || dt > MATCH_AFTER_MS) continue
    if (!best || Math.abs(dt) < Math.abs(best.tClosest - c.datetime)) best = p
  }
  return best
}

/** Prefer the clearer scene, then the one closer in time. */
function better(a: Capture, b: Capture | undefined, pass: Pass): boolean {
  if (!b) return true
  const ca = a.cloudCoverPct ?? 101
  const cb = b.cloudCoverPct ?? 101
  if (ca !== cb) return ca < cb
  return Math.abs(a.datetime - pass.tClosest) < Math.abs(b.datetime - pass.tClosest)
}

/**
 * Upgrade passes that have a real image to 'imaged' (mutates the passes). Returns the captures that
 * matched no pass, for the caller to resolve geometrically.
 */
export function attachCaptures(passes: Pass[], captures: readonly Capture[]): Capture[] {
  const chosen = new Map<Pass, Capture>()
  const unmatched: Capture[] = []
  for (const c of captures) {
    const p = passForCapture(c, passes)
    if (!p) {
      unmatched.push(c)
      continue
    }
    if (better(c, chosen.get(p), p)) chosen.set(p, c)
  }
  for (const [p, c] of chosen) {
    p.verdict = 'imaged'
    p.captureId = c.id
  }
  return unmatched
}

/** UTC calendar date "YYYY-MM-DD". */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * GIBS daily mosaics: the image for (satellite, UTC day) shows the place as seen on that day's daytime
 * pass. Exact time match first (the imagery module stamps the pass time), else the same UTC day's
 * daytime pass closest to nadir. One pass per capture. Returns the captures that matched.
 */
export function attachDailyCaptures(passes: Pass[], captures: readonly Capture[]): Capture[] {
  const matched: Capture[] = []
  const seen = new Set<string>()
  for (const c of captures) {
    const norad = captureNorad(c)
    // A capture id is one image: it may illustrate one pass only, even if a source repeats it.
    if (norad === undefined || seen.has(c.id)) continue
    seen.add(c.id)
    const day = utcDay(c.datetime)
    let best: Pass | undefined
    for (const p of passes) {
      if (p.norad !== norad || p.verdict === 'imaged') continue
      if (Math.abs(p.tClosest - c.datetime) < MATCH_BEFORE_MS) {
        best = p
        break
      }
      if (utcDay(p.tClosest) !== day || p.sunElevationDeg <= 0) continue
      if (!best || p.groundDistanceKm < best.groundDistanceKm) best = p
    }
    if (!best) continue
    best.verdict = 'imaged'
    best.captureId = c.id
    matched.push(c)
  }
  return matched
}
