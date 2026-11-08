/**
 * Test-only helpers (imported by *.test.ts, never by production code).
 * Loads the real CelesTrak catalog shipped in public/data/catalog.json.
 */
import raw from '../../public/data/catalog.json?raw'
import type { CatalogFile } from '@/types'
import { catalogRows, ingestCatalog, type AnyCatalogFile, type LoadedCatalog } from './catalog'

let file: CatalogFile | undefined

/** The shipped catalog as v1 rows, whatever format the file is in (v2 rows have names only for profiled objects). */
export function catalogFile(): CatalogFile {
  if (!file) {
    const f = JSON.parse(raw) as AnyCatalogFile
    const rows = catalogRows(f)
    file = { fetchedAt: f.fetchedAt, source: f.source, count: rows.length, rows }
  }
  return file
}

export function loadTestCatalog(): LoadedCatalog {
  return ingestCatalog(catalogFile())
}

export const WATERLOO = { lat: 43.4723, lon: -80.5449 }
export const TOKYO = { lat: 35.6762, lon: 139.6503 }
