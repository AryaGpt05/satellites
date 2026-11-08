/**
 * Catalog rows → satellite.js SGP4 records. Kept apart from catalog.ts so the first bundle (the HUD and the
 * boot log read the catalog) doesn't carry satellite.js: it arrives with the report engine and the globe.
 */
import { json2satrec, type OMMJsonObject, type SatRec } from 'satellite.js'
import type { CatalogRow } from '@/types'
import { catalogGeneration, getRow, ROW } from './catalog'

/** CatalogRow → CCSDS OMM object, the input satellite.js 7 expects (`json2satrec`). */
export function ommFromRow(r: CatalogRow): OMMJsonObject {
  return {
    OBJECT_NAME: r[ROW.name],
    OBJECT_ID: r[ROW.intlDes],
    EPOCH: r[ROW.epoch],
    MEAN_MOTION: r[ROW.meanMotion],
    ECCENTRICITY: r[ROW.ecc],
    INCLINATION: r[ROW.incl],
    RA_OF_ASC_NODE: r[ROW.raan],
    ARG_OF_PERICENTER: r[ROW.argp],
    MEAN_ANOMALY: r[ROW.meanAnomaly],
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: r[ROW.norad],
    ELEMENT_SET_NO: 999,
    BSTAR: r[ROW.bstar],
    MEAN_MOTION_DOT: r[ROW.ndot],
    MEAN_MOTION_DDOT: r[ROW.nddot],
  }
}

/** Build an SGP4 record from a row, or null if SGP4 rejects it at initialisation. */
export function satrecFromRow(r: CatalogRow): SatRec | null {
  try {
    const s = json2satrec(ommFromRow(r))
    return s.error ? null : s
  } catch {
    return null
  }
}

const satrecs = /* @__PURE__ */ new Map<number, SatRec | null>()
let cachedFor = -1

/** SGP4 record for a catalog object, built on first use and cached (null if SGP4 rejects it). */
export function satrecFor(norad: number): SatRec | null {
  if (cachedFor !== catalogGeneration()) {
    satrecs.clear()
    cachedFor = catalogGeneration()
  }
  const cached = satrecs.get(norad)
  if (cached !== undefined) return cached
  const r = getRow(norad)
  const s = r ? satrecFromRow(r) : null
  satrecs.set(norad, s)
  return s
}
