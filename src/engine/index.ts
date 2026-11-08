/**
 * engine: orbits, passes and the report. See docs/ARCHITECTURE.md ("engine → src/engine/index.ts").
 */
export { loadCatalog, getSatInfo, featuredSats, currentCatalog, type LoadedCatalog } from './catalog'
export { propagate, groundTrack, type SatState } from './propagate'
export { CATEGORY_INDEX } from './categories'
export {
  buildElementBuffer,
  keplerJ2World,
  ELEMENT_STRIDE,
  FLAG_FEATURED,
  type ElementBuffer,
} from './elements'
export { computeReport, type EngineReport, type ReportOptions, type ReportTimings } from './report'
export { geoWatchers } from './geostationary'
export { warmPassWorkers } from './pool'
export { PROFILES } from './profiles'

import type { SatProfile } from '@/types'
import { getSatInfo } from './catalog'
import { resolveProfile } from './profiles'

/** Curated profile for a satellite (after loadCatalog, the catalog name is used for family patterns). */
export function profileFor(norad: number): SatProfile | undefined {
  return getSatInfo(norad)?.profile ?? resolveProfile(norad)
}
