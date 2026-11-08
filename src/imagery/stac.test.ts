import { afterEach, describe, expect, it, vi } from 'vitest'
import pcS2 from './__fixtures__/pc-s2-waterloo.json'
import pcLandsat from './__fixtures__/pc-landsat-waterloo.json'
import esS2 from './__fixtures__/es-s2-waterloo.json'
import { pcCropUrl, pcPointUrl } from './endpoints'
import {
  dedupeCandidates,
  earthSearchItemToCandidate,
  footprintMarginKm,
  isPcS2ItemId,
  normalizePlatform,
  noradForPlatform,
  pcItemIdFromProductUri,
  pcItemToCandidate,
  searchBody,
  searchCapturesDetailed,
  stacIso,
  stacSearchAll,
  type Candidate,
  type StacItem,
  type StacItemCollection,
} from './stac'

const WATERLOO = { lat: 43.4723, lon: -80.5449 }
const s2Items = (pcS2 as unknown as StacItemCollection).features
const lsItems = (pcLandsat as unknown as StacItemCollection).features
const esItems = (esS2 as unknown as StacItemCollection).features
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

describe('platforms', () => {
  it('normalizes archive platform names to lowercase ids', () => {
    expect(normalizePlatform('Sentinel-2C')).toBe('sentinel-2c')
    expect(normalizePlatform('Sentinel-2A')).toBe('sentinel-2a')
    expect(normalizePlatform(' sentinel-2b ')).toBe('sentinel-2b')
    expect(normalizePlatform('SENTINEL2B')).toBe('sentinel-2b')
    expect(normalizePlatform('landsat-9')).toBe('landsat-9')
    expect(normalizePlatform('LANDSAT_8')).toBe('landsat-8')
    expect(normalizePlatform('landsat8')).toBe('landsat-8')
  })
  it('maps platforms to NORAD ids', () => {
    expect(noradForPlatform('Sentinel-2A')).toBe(40697)
    expect(noradForPlatform('Sentinel-2B')).toBe(42063)
    expect(noradForPlatform('Sentinel-2C')).toBe(60989)
    expect(noradForPlatform('landsat-8')).toBe(39084)
    expect(noradForPlatform('landsat-9')).toBe(49260)
    expect(noradForPlatform('landsat-7')).toBeUndefined()
  })
})

describe('URL builders', () => {
  it('builds a Sentinel-2 crop as lon/lat bbox with the TCI render params', () => {
    const url = pcCropUrl('sentinel-2-l2a', 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803', WATERLOO, { halfSizeKm: 3, px: 768 })
    expect(url).toBe(
      'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/-80.582077,43.445320,-80.507723,43.499280/768x768.png' +
        '?collection=sentinel-2-l2a&item=S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803' +
        '&assets=visual&asset_bidx=visual%7C1%2C2%2C3&nodata=0',
    )
  })
  it('builds a Landsat crop with RGB assets and the colour formula', () => {
    const url = pcCropUrl('landsat-c2-l2', 'LC09_L2SP_019030_20261022_02_T1', WATERLOO, { halfSizeKm: 3, px: 512 })
    const [path, query] = url.split('?')
    expect(path).toBe('https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/-80.582077,43.445320,-80.507723,43.499280/512x512.png')
    expect(query).toBe(
      'collection=landsat-c2-l2&item=LC09_L2SP_019030_20261022_02_T1&assets=red&assets=green&assets=blue' +
        '&color_formula=gamma%20RGB%202.7,%20saturation%201.5,%20sigmoidal%20RGB%2015%200.55',
    )
  })
  it('keeps west < east and south < north, and clamps px', () => {
    const url = pcCropUrl('sentinel-2-l2a', 'x', { lat: -33.86, lon: 151.21 }, { halfSizeKm: 5, px: 99999 })
    const [w, s, e, n] = /bbox\/([^/]+)\//.exec(url)![1].split(',').map(Number)
    expect(w).toBeLessThan(e)
    expect(s).toBeLessThan(n)
    expect(url).toContain('/2048x2048.png')
    expect(pcCropUrl('sentinel-2-l2a', 'x', WATERLOO, { halfSizeKm: 3, px: 1 })).toContain('/8x8.png')
  })
  it('builds a point query as lon,lat', () => {
    expect(pcPointUrl('sentinel-2-l2a', 'ID', WATERLOO, 'SCL')).toBe(
      'https://planetarycomputer.microsoft.com/api/data/v1/item/point/-80.544900,43.472300?collection=sentinel-2-l2a&item=ID&assets=SCL',
    )
  })
})

describe('PC item → capture', () => {
  it('converts a Sentinel-2 item', () => {
    const c = pcItemToCandidate(s2Items[2], WATERLOO)!
    expect(c).toBeDefined()
    const cap = c.capture
    expect(cap.id).toBe('S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803')
    expect(cap.provider).toBe('planetary-computer')
    expect(cap.collection).toBe('sentinel-2-l2a')
    expect(cap.platform).toBe('sentinel-2c')
    expect(cap.norad).toBe(60989)
    expect(cap.datetime).toBe(Date.parse('2026-11-01T16:14:21.025Z'))
    expect(cap.gsdM).toBe(10)
    expect(cap.cloudCoverPct).toBeCloseTo(25.456536)
    // S2 has no view:sun_elevation on PC: derived from the mean solar zenith
    const zenith = s2Items[2].properties['s2:mean_solar_zenith'] as number
    expect(cap.sunElevationDeg).toBeCloseTo(90 - zenith, 6)
    expect(cap.footprint!.length).toBeGreaterThanOrEqual(4)
    expect(cap.footprint![0]).toHaveLength(2)
    expect(cap.previewUrl).toMatch(/^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/preview\.png\?collection=sentinel-2-l2a/)
    expect(cap.sourceUrl).toBe(
      'https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a/items/S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
    )
    expect(cap.cropUrl({ halfSizeKm: 3, px: 768 })).toBe(pcCropUrl('sentinel-2-l2a', cap.itemId, WATERLOO, { halfSizeKm: 3, px: 768 }))
    expect(c.tile).toBe('17TNJ')
    expect(c.processing).toBe('05.13|20261102T164803')
  })

  it('converts a Landsat item and uses view:sun_elevation', () => {
    const cap = pcItemToCandidate(lsItems[0], WATERLOO)!.capture
    expect(cap.platform).toBe('landsat-9')
    expect(cap.norad).toBe(49260)
    expect(cap.gsdM).toBe(30)
    expect(cap.sunElevationDeg).toBeCloseTo(30.92594659)
    expect(cap.cloudCoverPct).toBeCloseTo(11.68)
    expect(cap.cropUrl({ halfSizeKm: 3, px: 256 })).toContain('collection=landsat-c2-l2&item=LC09_L2SP_018030_20261031_02_T1&assets=red')
  })

  it('drops Landsat 7', () => {
    const l7 = clone(lsItems[0])
    l7.properties.platform = 'landsat-7'
    expect(pcItemToCandidate(l7, WATERLOO)).toBeUndefined()
  })
})

describe('Earth Search fallback', () => {
  it('rebuilds the PC item id from the ESA product URI (matches the real PC ids)', () => {
    const pcIds = new Set(s2Items.map((i) => i.id))
    for (const it of esItems) {
      const id = pcItemIdFromProductUri(it.properties['s2:product_uri'] as string)
      expect(id && pcIds.has(id)).toBe(true)
      expect(isPcS2ItemId(id!)).toBe(true)
    }
    expect(pcItemIdFromProductUri('garbage')).toBeUndefined()
    expect(isPcS2ItemId('S2B_T17TNJ_20261106T161753_L2A')).toBe(false)
  })

  it('converts items, cropping via PC and previewing via the E84 thumbnail', () => {
    const c = earthSearchItemToCandidate(esItems[0], WATERLOO)!
    expect(c.capture.provider).toBe('earth-search')
    expect(c.capture.platform).toBe('sentinel-2b')
    expect(c.capture.itemId).toBe('S2B_MSIL2A_20261106T161449_R140_T17TNJ_20261106T195148')
    expect(c.capture.cropUrl({ halfSizeKm: 3, px: 64 })).toContain('planetarycomputer.microsoft.com/api/data/v1/item/bbox/')
    expect(c.capture.previewUrl).toMatch(/L2A_PVI\.jpg$/)
    expect(c.capture.sunElevationDeg).toBeCloseTo(29.2934520718594)
    expect(c.tile).toBe('17TNJ')
  })

  it('degrades to the thumbnail when no PC id can be derived', () => {
    const it2 = clone(esItems[0])
    delete it2.properties['s2:product_uri']
    const c = earthSearchItemToCandidate(it2, WATERLOO)!
    expect(c.capture.itemId).toBe(esItems[0].id)
    expect(c.capture.cropUrl({ halfSizeKm: 3, px: 64 })).toBe(c.capture.previewUrl)
  })
})

describe('dedupe', () => {
  const cands = () => s2Items.map((i) => pcItemToCandidate(i, WATERLOO)!).concat(lsItems.map((i) => pcItemToCandidate(i, WATERLOO)!))

  it('keeps every distinct overflight in the real fixture, newest first', () => {
    const out = dedupeCandidates(cands(), WATERLOO)
    expect(out).toHaveLength(s2Items.length + lsItems.length)
    const times = out.map((c) => c.capture.datetime)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('keeps the newest processing of the same datatake + tile', () => {
    const newer = s2Items[2]
    const older: StacItem = clone(newer)
    older.id = newer.id.replace(/_\d{8}T\d{6}$/, '_20261101T235959') // generated earlier… but
    older.properties['s2:processing_baseline'] = '05.11' // …with an older baseline
    const reproc: StacItem = clone(newer)
    reproc.id = newer.id.replace(/_\d{8}T\d{6}$/, '_20261120T101010') // reprocessed later
    const input = [older, newer, reproc].map((i) => pcItemToCandidate(i, WATERLOO)!)
    const out = dedupeCandidates(input, WATERLOO)
    expect(out).toHaveLength(1)
    expect(out[0].capture.itemId).toBe(reproc.id)
  })

  it('keeps one tile per datatake: the one the place sits deepest inside', () => {
    const a = pcItemToCandidate(s2Items[2], WATERLOO)!
    const edge: StacItem = clone(s2Items[2])
    edge.id = edge.id.replace('T17TNJ', 'T17TNH')
    edge.properties['s2:mgrs_tile'] = '17TNH'
    // shift the footprint so the place is ~1 km inside its northern edge
    const ring = (edge.geometry as { coordinates: number[][][] }).coordinates[0]
    const top = Math.max(...ring.map((p) => p[1]))
    const shift = WATERLOO.lat + 0.01 - top
    ;(edge.geometry as { coordinates: number[][][] }).coordinates[0] = ring.map(([x, y]) => [x, y + shift])
    const b = pcItemToCandidate(edge, WATERLOO)!
    expect(footprintMarginKm(b.capture.footprint, WATERLOO)).toBeLessThan(footprintMarginKm(a.capture.footprint, WATERLOO))
    expect(dedupeCandidates([b, a], WATERLOO).map((c) => c.capture.itemId)).toEqual([a.capture.itemId])
  })

  it('merges adjacent Landsat rows of the same overflight but not different satellites', () => {
    const row30 = pcItemToCandidate(lsItems[0], WATERLOO)!
    const row29: Candidate = { ...row30, tile: '018/029', capture: { ...row30.capture, id: 'r29', itemId: 'r29', datetime: row30.capture.datetime - 24_000, footprint: undefined } }
    const other: Candidate = { ...row30, capture: { ...row30.capture, id: 'l8', itemId: 'l8', platform: 'landsat-8', datetime: row30.capture.datetime + 10_000 } }
    const out = dedupeCandidates([row29, row30, other], WATERLOO)
    expect(out.map((c) => c.capture.itemId).sort()).toEqual([row30.capture.itemId, 'l8'].sort())
  })
})

describe('search', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('builds search bodies (Point, ISO range without ms, Landsat platform filter)', () => {
    const start = Date.parse('2026-11-01T00:00:00.400Z')
    const end = Date.parse('2026-11-08T03:00:00.200Z')
    const b = searchBody('landsat-c2-l2', WATERLOO, start, end)
    expect(b.intersects).toEqual({ type: 'Point', coordinates: [-80.5449, 43.4723] })
    expect(b.datetime).toBe('2026-11-01T00:00:00Z/2026-11-08T03:00:01Z')
    expect(b.limit).toBe(100)
    expect(b.query).toEqual({ platform: { in: ['landsat-8', 'landsat-9'] } })
    expect(searchBody('sentinel-2-l2a', WATERLOO, start, end).query).toBeUndefined()
    expect(stacIso(Date.parse('2026-11-08T03:45:12.999Z'))).toBe('2026-11-08T03:45:12Z')
  })

  it('follows POST next links with their token body', async () => {
    const calls: { url: string; body: unknown }[] = []
    const page1 = { features: s2Items.slice(0, 2), links: [{ rel: 'next', method: 'POST', href: 'https://x/search', body: { token: 'next:2' } }] }
    const page2 = { features: s2Items.slice(2, 3), links: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        calls.push({ url, body })
        return new Response(JSON.stringify(body.token ? page2 : page1), { status: 200, headers: { 'content-type': 'application/json' } })
      }),
    )
    const items = await stacSearchAll('https://x/search', { collections: ['sentinel-2-l2a'] }, undefined)
    expect(items.map((i) => i.id)).toEqual(s2Items.slice(0, 3).map((i) => i.id))
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toEqual({ token: 'next:2' }) // merge: false → body replaces
  })

  it('falls back to Earth Search for Sentinel-2 when PC search fails, and reports it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        if (url.includes('planetarycomputer') && body.collections[0] === 'sentinel-2-l2a') return new Response('down', { status: 503 })
        if (url.includes('planetarycomputer')) return Response.json({ features: lsItems, links: [] })
        return Response.json({ features: esItems, links: [] })
      }),
    )
    const r = await searchCapturesDetailed(WATERLOO, Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-11-08T00:00:00Z'))
    const providers = new Set(r.captures.map((c) => c.provider))
    expect(providers).toEqual(new Set(['earth-search', 'planetary-computer']))
    expect(r.captures.filter((c) => c.collection === 'sentinel-2-l2a')).toHaveLength(esItems.length)
    expect(r.degraded.join(' ')).toMatch(/Earth Search/)
  })

  it('throws only when every archive fails; aborts propagate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
    await expect(searchCapturesDetailed(WATERLOO, 0, 1e12)).rejects.toThrow(/unreachable/)
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(searchCapturesDetailed(WATERLOO, 0, 1e12, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
