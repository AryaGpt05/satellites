/**
 * Test-only helpers (imported by *.test.ts, never by production code).
 * Loads the real CelesTrak catalog shipped in public/data/catalog.json.
 */
import raw from '../../public/data/catalog.json?raw'
import type { CatalogFile } from '@/types'
import { ingestCatalog, type LoadedCatalog } from './catalog'

let file: CatalogFile | undefined

export function catalogFile(): CatalogFile {
  return (file ??= JSON.parse(raw) as CatalogFile)
}

export function loadTestCatalog(): LoadedCatalog {
  return ingestCatalog(catalogFile())
}

export const WATERLOO = { lat: 43.4723, lon: -80.5449 }
export const TOKYO = { lat: 35.6762, lon: 139.6503 }
