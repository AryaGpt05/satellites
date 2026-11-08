/**
 * Best look (decision #1): exported for the controller, which preloads the hero image while the
 * camera is still flying. The ranking itself lives in lib/bestLook.ts (pure, unit-tested).
 */
import type { Report } from '@/types'
import { cropSpec, displayUrl } from './lib/captures'
import { pickBestLook } from './lib/bestLook'

export { pickBestLook, isClouded, type BestLook } from './lib/bestLook'

/** The exact URL the hero AND PassDetail request for the best look's image (so a preload is a cache hit). */
export function bestLookImageUrl(report: Report): string | undefined {
  const best = pickBestLook(report)
  if (!best || best.kind === 'geo') return undefined
  return displayUrl(best.capture, cropSpec(best.capture.collection))
}
