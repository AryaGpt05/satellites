/**
 * Fetch the live GP (OMM) catalog from CelesTrak and write a compact catalog to public/data/catalog.json.
 * Runs in GitHub Actions on a schedule (.github/workflows/catalog.yml). CelesTrak asks clients not to
 * re-download the same data more than once every 2 hours — the schedule respects that.
 *
 * Usage: tsx scripts/fetch-catalog.ts [outPath]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CatalogFile, CatalogRow } from '../src/types'

const OUT = process.argv[2] ?? 'public/data/catalog.json'
const UA = 'overflight-catalog-bot/1.0 (+https://github.com/dev-Armaan/satellites)'

// GROUP=active is ~12k+ payloads. We also pull a few groups that include non-"active" but relevant objects.
const GROUPS = ['active', 'stations', 'weather', 'resource', 'planet', 'goes', 'noaa', 'sarsat']

interface Omm {
  OBJECT_NAME: string
  OBJECT_ID: string
  EPOCH: string
  MEAN_MOTION: number
  ECCENTRICITY: number
  INCLINATION: number
  RA_OF_ASC_NODE: number
  ARG_OF_PERICENTER: number
  MEAN_ANOMALY: number
  NORAD_CAT_ID: number
  BSTAR: number
  MEAN_MOTION_DOT: number
  MEAN_MOTION_DDOT: number
}

async function fetchGroup(group: string): Promise<Omm[]> {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA } })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const text = await res.text()
      if (!text.trim().startsWith('[')) throw new Error(`unexpected body: ${text.slice(0, 120)}`)
      return JSON.parse(text) as Omm[]
    } catch (e) {
      console.warn(`[catalog] ${group} attempt ${attempt + 1} failed: ${(e as Error).message}`)
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt))
    }
  }
  throw new Error(`failed to fetch group ${group}`)
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d

async function main() {
  const byId = new Map<number, Omm>()
  for (const g of GROUPS) {
    try {
      const list = await fetchGroup(g)
      for (const o of list) {
        const prev = byId.get(o.NORAD_CAT_ID)
        if (!prev || prev.EPOCH < o.EPOCH) byId.set(o.NORAD_CAT_ID, o)
      }
      console.log(`[catalog] ${g}: ${list.length}`)
    } catch (e) {
      if (g === 'active') throw e
      console.warn(`[catalog] skipping ${g}: ${(e as Error).message}`)
    }
  }
  const rows: CatalogRow[] = [...byId.values()]
    .filter((o) => Number.isFinite(o.MEAN_MOTION) && o.MEAN_MOTION > 0)
    .sort((a, b) => a.NORAD_CAT_ID - b.NORAD_CAT_ID)
    .map((o) => [
      o.NORAD_CAT_ID,
      o.OBJECT_NAME.trim(),
      o.OBJECT_ID,
      o.EPOCH,
      round(o.MEAN_MOTION, 8),
      round(o.ECCENTRICITY, 7),
      round(o.INCLINATION, 4),
      round(o.RA_OF_ASC_NODE, 4),
      round(o.ARG_OF_PERICENTER, 4),
      round(o.MEAN_ANOMALY, 4),
      o.BSTAR,
      o.MEAN_MOTION_DOT,
      o.MEAN_MOTION_DDOT,
    ])
  if (rows.length < 5000) throw new Error(`suspiciously small catalog: ${rows.length}`)
  const file: CatalogFile = {
    fetchedAt: new Date().toISOString(),
    source: 'CelesTrak GP',
    count: rows.length,
    rows,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(file))
  console.log(`[catalog] wrote ${rows.length} rows → ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
