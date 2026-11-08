/**
 * Orbit catalog: loads /data/catalog.json (CelesTrak GP mean elements, see scripts/fetch-catalog.ts),
 * resolves every object against the curated profiles, and hands out SGP4 records on demand.
 *
 * SGP4 records (satellite.js `SatRec`, ~100 numbers each) are built lazily: the globe only needs the
 * mean elements (see elements.ts), and pass prediction builds its own records inside the workers.
 * Rows that cannot possibly initialise (non-finite numbers, e ∉ [0,1), n ≤ 0) are dropped at load and
 * counted in `skipped`; a row whose SGP4 initialisation still fails is flagged the first time it is used.
 */
import { json2satrec, type OMMJsonObject, type SatRec } from 'satellite.js'
import type { CatalogFile, CatalogRow, SatInfo } from '@/types'
import { displayNameFor, resolveProfile } from './profiles'

export interface LoadedCatalog {
  fetchedAt: string
  source: string
  sats: SatInfo[]
  byNorad: Map<number, SatInfo>
  /** Rows dropped at load because their elements are unusable. Not part of `sats`. */
  skipped: number
}

/** Field indices of a CatalogRow (see src/types.ts). */
export const ROW = {
  norad: 0,
  name: 1,
  intlDes: 2,
  epoch: 3,
  meanMotion: 4,
  ecc: 5,
  incl: 6,
  raan: 7,
  argp: 8,
  meanAnomaly: 9,
  bstar: 10,
  ndot: 11,
  nddot: 12,
} as const

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

/** Epoch of a row as epoch ms (UTC). CelesTrak epochs carry no zone suffix; they are UTC. */
export function rowEpochMs(r: CatalogRow): number {
  const iso = r[ROW.epoch]
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`)
}

function rowIsUsable(r: CatalogRow): boolean {
  if (!Array.isArray(r) || r.length < 13) return false
  if (!Number.isInteger(r[ROW.norad]) || typeof r[ROW.name] !== 'string') return false
  for (let i = 4; i <= 12; i++) if (!Number.isFinite(r[i])) return false
  const e = r[ROW.ecc]
  return r[ROW.meanMotion] > 0 && e >= 0 && e < 1 && Number.isFinite(rowEpochMs(r))
}

// ───────────────────────────── singleton state ─────────────────────────────

let loaded: LoadedCatalog | undefined
let pending: Promise<LoadedCatalog> | undefined
const rows = new Map<number, CatalogRow>()
const satrecs = new Map<number, SatRec | null>()

/**
 * Install a parsed catalog file as the singleton (used by loadCatalog; tests call it directly).
 * Re-ingesting replaces the previous catalog and drops cached SGP4 records.
 */
export function ingestCatalog(file: CatalogFile): LoadedCatalog {
  rows.clear()
  satrecs.clear()
  const sats: SatInfo[] = []
  const byNorad = new Map<number, SatInfo>()
  let skipped = 0
  for (const r of file.rows) {
    if (!rowIsUsable(r) || byNorad.has(r[ROW.norad])) {
      skipped++
      continue
    }
    const norad = r[ROW.norad]
    const name = r[ROW.name].trim()
    const profile = resolveProfile(norad, name)
    const info: SatInfo = {
      norad,
      name,
      displayName: displayNameFor(name, profile),
      category: profile?.category ?? 'other',
      profile,
    }
    rows.set(norad, r)
    sats.push(info)
    byNorad.set(norad, info)
  }
  loaded = { fetchedAt: file.fetchedAt, source: file.source, sats, byNorad, skipped }
  pending = Promise.resolve(loaded)
  return loaded
}

/** Fetch and ingest the catalog once; concurrent and later calls share the same promise. */
export function loadCatalog(url = '/data/catalog.json', signal?: AbortSignal): Promise<LoadedCatalog> {
  if (pending) return pending
  pending = (async () => {
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`Catalog request failed: HTTP ${res.status}`)
    const file = (await res.json()) as CatalogFile
    if (!file || !Array.isArray(file.rows)) throw new Error('Catalog file is malformed')
    return ingestCatalog(file)
  })()
  // A failed load must not poison the cache: the next call retries.
  pending.catch(() => {
    pending = undefined
  })
  return pending
}

/** The loaded catalog, if any (synchronous). */
export function currentCatalog(): LoadedCatalog | undefined {
  return loaded
}

export function getSatInfo(norad: number): SatInfo | undefined {
  return loaded?.byNorad.get(norad)
}

export function getRow(norad: number): CatalogRow | undefined {
  return rows.get(norad)
}

/** SGP4 record for a catalog object, built on first use and cached (null if SGP4 rejects it). */
export function satrecFor(norad: number): SatRec | null {
  const cached = satrecs.get(norad)
  if (cached !== undefined) return cached
  const r = rows.get(norad)
  const s = r ? satrecFromRow(r) : null
  satrecs.set(norad, s)
  return s
}

/** Satellites worth calling out (everything we have a profile for). */
export function featuredSats(cat: LoadedCatalog | undefined = loaded): SatInfo[] {
  return cat ? cat.sats.filter((s) => s.category !== 'other') : []
}
