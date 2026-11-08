/**
 * Best look: the single clearest real picture of the place in a report (decision #1).
 * Rank: detailed captures (Sentinel-2/Landsat) by spot clarity, then scene cloud, then recency;
 * then daily weather mosaics; then nothing (the geostationary band covers 'geo').
 * Exported for the controller, which preloads the hero image while the camera is still flying.
 */
import type { Capture, Pass, Report, SpotCloud } from '@/types'
import { captureFor, cropSpec, displayUrl } from './lib/captures'

export interface BestLook {
  pass: Pass
  capture?: Capture
  kind: 'detailed' | 'mosaic' | 'geo'
}

const SPOT_RANK: Record<SpotCloud, number> = { clear: 0, cirrus: 1, unknown: 2, shadow: 3, cloud: 4 }
const isDetailed = (c: Capture) => c.collection === 'sentinel-2-l2a' || c.collection === 'landsat-c2-l2'

export function pickBestLook(report: Report): BestLook | null {
  const imaged = report.passes
    .filter((p) => p.verdict === 'imaged')
    .map((pass) => ({ pass, capture: captureFor(report, pass) }))
    .filter((x): x is { pass: Pass; capture: Capture } => !!x.capture)
  const score = (c: Capture) => [SPOT_RANK[c.spot ?? 'unknown'], Math.round((c.cloudCoverPct ?? 50) / 5)]
  const better = (a: { pass: Pass; capture: Capture }, b: { pass: Pass; capture: Capture }) => {
    const [sa, ca] = score(a.capture)
    const [sb, cb] = score(b.capture)
    if (sa !== sb) return sa - sb
    if (ca !== cb) return ca - cb
    return b.pass.tClosest - a.pass.tClosest
  }
  const detailed = imaged.filter((x) => isDetailed(x.capture)).sort(better)
  if (detailed[0]) return { ...detailed[0], kind: 'detailed' }
  const mosaics = imaged.filter((x) => !isDetailed(x.capture)).sort(better)
  if (mosaics[0]) return { ...mosaics[0], kind: 'mosaic' }
  return null
}

/** The exact URL PassDetail requests for the best look's image (so a preload is a cache hit). */
export function bestLookImageUrl(report: Report): string | undefined {
  const best = pickBestLook(report)
  if (!best?.capture) return undefined
  return displayUrl(best.capture, cropSpec(best.capture.collection))
}
