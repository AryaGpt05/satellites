import { describe, expect, it } from 'vitest'
import { PROFILES, displayNameFor, noradForGibsCollection, noradForPlatform, resolveProfile } from './profiles'
import { featuredSats, getSatInfo, ingestCatalog, satrecFor } from './catalog'
import { propagate, groundTrack } from './propagate'
import { catalogFile, loadTestCatalog } from './testing'
import type { CatalogRow } from '@/types'

describe('catalog', () => {
  const cat = loadTestCatalog()

  it('ingests the real CelesTrak catalog', () => {
    const file = catalogFile()
    expect(cat.sats.length + cat.skipped).toBe(file.rows.length)
    expect(cat.sats.length).toBeGreaterThan(15_000)
    expect(cat.byNorad.get(25544)?.displayName).toBe('ISS')
    expect(getSatInfo(60989)?.category).toBe('open-optical')
  })

  it('drops malformed rows and duplicates instead of throwing', () => {
    const good = catalogFile().rows[0]
    const bad: CatalogRow = [...good] as CatalogRow
    bad[0] = 999_999
    bad[5] = 1.5 // eccentricity out of range
    const c = ingestCatalog({ fetchedAt: '2026-11-08T00:00:00Z', source: 'test', count: 3, rows: [good, good, bad] })
    expect(c.sats).toHaveLength(1)
    expect(c.skipped).toBe(2)
    loadTestCatalog() // restore
  })

  it('builds valid SGP4 records for every featured satellite', () => {
    const featured = featuredSats(cat)
    expect(featured.length).toBeGreaterThan(400)
    const t = Date.parse(cat.fetchedAt)
    const failed = featured.filter((s) => !satrecFor(s.norad) || !propagate(s.norad, t))
    expect(failed.map((s) => s.name)).toEqual([])
  })

  it('propagates the ISS to a plausible state', () => {
    const s = propagate(25544, Date.parse(cat.fetchedAt))!
    expect(s.altKm).toBeGreaterThan(380)
    expect(s.altKm).toBeLessThan(460)
    expect(Math.abs(s.lat)).toBeLessThanOrEqual(51.7)
    expect(s.velKmS).toBeGreaterThan(7.5)
    expect(s.velKmS).toBeLessThan(7.8)
    expect(Math.hypot(...s.ecef)).toBeCloseTo(6371 + s.altKm, -2)
    const track = groundTrack(25544, Date.parse(cat.fetchedAt), Date.parse(cat.fetchedAt) + 600_000)
    expect(track).toHaveLength(31)
  })
})

describe('profiles', () => {
  const cat = loadTestCatalog()

  it('every exact NORAD id exists in the catalog under the expected name', () => {
    const missing: string[] = []
    for (const p of PROFILES) for (const id of p.norad ?? []) if (!cat.byNorad.has(id)) missing.push(`${p.displayName ?? p.namePattern} ${id}`)
    expect(missing).toEqual([])
    expect(cat.byNorad.get(40697)?.name).toBe('SENTINEL-2A')
    expect(cat.byNorad.get(49260)?.name).toBe('LANDSAT 9')
    expect(cat.byNorad.get(43013)?.name).toMatch(/^NOAA 20/)
    expect(cat.byNorad.get(48274)?.name).toBe('CSS (TIANHE)')
  })

  it('every name pattern matches at least one catalog object', () => {
    const unmatched = PROFILES.filter((p) => p.namePattern && !p.norad).filter((p) => {
      const re = new RegExp(p.namePattern!, 'i')
      return !cat.sats.some((s) => re.test(s.name))
    })
    expect(unmatched.map((p) => p.namePattern)).toEqual([])
  })

  it('keeps families apart', () => {
    expect(resolveProfile(0, 'JILIN-1 GAOFEN 03D09')?.operator).toBe('Chang Guang Satellite')
    expect(resolveProfile(0, 'GAOFEN-3 02')?.category).toBe('radar')
    expect(resolveProfile(0, 'GAOFEN-13 01')).toBeUndefined() // geostationary, not an LEO imager
    expect(resolveProfile(0, 'SUPERVIEW NEO-2 01')?.category).toBe('radar')
    expect(resolveProfile(0, 'SUPERVIEW NEO-1 01')?.category).toBe('commercial-optical')
    expect(resolveProfile(0, 'FLOCK 4BE-18')?.swathKm).toBe(32)
    expect(resolveProfile(0, 'ISS (UNITY)')).toBeUndefined()
    expect(resolveProfile(0, 'STARLINK-1234')).toBeUndefined()
  })

  it('maps archive platforms and GIBS collections to NORAD ids', () => {
    expect(noradForPlatform('Sentinel-2C')).toBe(60989)
    expect(noradForPlatform('landsat-8')).toBe(39084)
    expect(noradForGibsCollection('gibs-viirs-noaa21')).toBe(54234)
    expect(noradForGibsCollection('gibs-modis-aqua')).toBe(27424)
  })

  it('makes readable constellation names', () => {
    const p = resolveProfile(0, 'CAPELLA-14 (ACADIA-4)')
    expect(displayNameFor('CAPELLA-14 (ACADIA-4)', p)).toBe('Capella-14')
    expect(displayNameFor('LEGION 3', resolveProfile(60452, 'LEGION 3'))).toBe('WorldView Legion 3')
    expect(displayNameFor('COSMO-SKYMED 2', resolveProfile(0, 'COSMO-SKYMED 2'))).toBe('COSMO-SkyMed 2')
    expect(displayNameFor('STARLINK-1234')).toBe('STARLINK-1234')
  })

  it('has a one-sentence blurb on every profile', () => {
    for (const p of PROFILES) {
      expect(p.blurb.length).toBeGreaterThan(10)
      expect(p.blurb.length).toBeLessThan(120)
      expect(p.blurb.trim().endsWith('.')).toBe(true)
      expect((p.blurb.match(/\. /g) ?? []).length).toBe(0)
    }
  })

  it('logs how many catalog objects each profile matches', () => {
    const rows = PROFILES.map((p) => {
      const n = cat.sats.filter((s) => s.profile === p).length
      return `${(p.displayName ?? p.namePattern ?? '').padEnd(34)} ${p.category.padEnd(18)} ${n}`
    })
    console.log(rows.join('\n'))
    expect(rows.length).toBe(PROFILES.length)
  })
})
