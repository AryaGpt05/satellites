import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Capture } from '@/types'
import { classifyQaPixel, classifyScl, classifySclArea, spotAreaQuery, spotCloud, spotCloudQuery } from './cloud'

const WATERLOO = { lat: 43.4723, lon: -80.5449 }

const cap = (over: Partial<Capture>): Capture => ({
  id: 'x',
  provider: 'planetary-computer',
  collection: 'sentinel-2-l2a',
  itemId: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
  platform: 'sentinel-2c',
  datetime: 0,
  gsdM: 10,
  cropUrl: () => '',
  ...over,
})

describe('classifiers', () => {
  it('maps Sentinel-2 SCL classes', () => {
    expect(classifyScl(8)).toBe('cloud')
    expect(classifyScl(9)).toBe('cloud')
    expect(classifyScl(10)).toBe('cirrus') // thin cirrus is its own class (false positives over cities)
    expect(classifyScl(3)).toBe('shadow')
    for (const v of [2, 4, 5, 6, 7, 11]) expect(classifyScl(v)).toBe('clear')
    expect(classifyScl(0)).toBe('unknown')
    expect(classifyScl(1)).toBe('unknown')
    expect(classifyScl(null)).toBe('unknown')
    expect(classifyScl(Number.NaN)).toBe('unknown')
  })

  it('classifies a 1 km SCL box by majority', () => {
    // Measured 2026-11-08, the 10×10 box around Waterloo: S2C 1 Nov (visibly clear) is mostly class 10
    // with a few 8s; S2B 6 Nov (overcast) is all class 9.
    const s2c = [...Array(88).fill(10), ...Array(10).fill(8), 9, 9]
    expect(classifySclArea(s2c)).toBe('cirrus')
    expect(classifySclArea(Array(100).fill(9))).toBe('cloud')
    expect(classifySclArea([...Array(60).fill(4), ...Array(40).fill(8)])).toBe('clear')
    expect(classifySclArea([...Array(50).fill(5), ...Array(50).fill(3)])).toBe('shadow') // tie → pessimistic
    // No data / defective pixels are ignored, and a mostly empty box says nothing.
    expect(classifySclArea([...Array(30).fill(0), ...Array(70).fill(4)])).toBe('clear')
    expect(classifySclArea([...Array(70).fill(0), ...Array(30).fill(4)])).toBe('unknown')
    expect(classifySclArea([])).toBe('unknown')
  })

  it('maps Landsat QA_PIXEL bits (values measured at Waterloo)', () => {
    expect(classifyQaPixel(21824)).toBe('clear') // LC09 2026-10-22: clear bit set, no cloud bits
    expect(classifyQaPixel(22280)).toBe('cloud') // LC08 2026-10-14: bit 3 high-confidence cloud
    expect(classifyQaPixel(1)).toBe('unknown') // fill
    expect(classifyQaPixel(1 << 1)).toBe('cloud') // dilated
    expect(classifyQaPixel(1 << 2)).toBe('cloud') // cirrus
    expect(classifyQaPixel(1 << 4)).toBe('shadow')
    expect(classifyQaPixel((1 << 4) | (1 << 3))).toBe('cloud') // cloud wins over its own shadow
    expect(classifyQaPixel(undefined)).toBe('unknown')
  })
})

describe('spot cloud queries', () => {
  it('reads SCL for Sentinel-2 and qa_pixel for Landsat; nothing for GIBS', () => {
    expect(spotCloudQuery(cap({}), WATERLOO)!.url).toBe(
      'https://planetarycomputer.microsoft.com/api/data/v1/item/point/-80.544900,43.472300?collection=sentinel-2-l2a&item=S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803&assets=SCL',
    )
    expect(spotCloudQuery(cap({ collection: 'landsat-c2-l2', itemId: 'LC09_L2SP_019030_20261022_02_T1' }), WATERLOO)!.url).toContain('&assets=qa_pixel')
    expect(spotCloudQuery(cap({ provider: 'gibs', collection: 'gibs-viirs-noaa20', itemId: 'L@2026-11-07' }), WATERLOO)).toBeNull()
    expect(spotCloudQuery(cap({ provider: 'earth-search', itemId: 'S2B_T17TNJ_20261106T161753_L2A' }), WATERLOO)).toBeNull()
  })

  it('reads the 1 km SCL box for Planetary Computer Sentinel-2 items only', () => {
    const url = spotAreaQuery(cap({}), WATERLOO)!.url
    expect(url).toMatch(/\/item\/bbox\/-80\.55\d+,43\.46\d+,-80\.53\d+,43\.47\d+\/10x10\.png\?/)
    expect(url).toContain('item=S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803')
    expect(url).toContain('assets=SCL')
    expect(spotAreaQuery(cap({ collection: 'landsat-c2-l2', itemId: 'LC09_L2SP_019030_20261022_02_T1' }), WATERLOO)).toBeNull()
    expect(spotAreaQuery(cap({ provider: 'gibs', collection: 'gibs-viirs-noaa20', itemId: 'L@2026-11-07' }), WATERLOO)).toBeNull()
  })
})

describe('spotCloud', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('classifies and caches the point value', async () => {
    const f = vi.fn(async () => Response.json({ coordinates: [-80.5449, 43.4723], values: [9.0], band_names: ['SCL_b1'] }))
    vi.stubGlobal('fetch', f)
    const c = cap({ itemId: 'S2B_MSIL2A_20261106T161449_R140_T17TNJ_20261106T195148' })
    expect(await spotCloud(c, WATERLOO)).toBe('cloud')
    expect(await spotCloud(c, WATERLOO)).toBe('cloud')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('answers unknown for GIBS without a request, and when the place is off the scene', async () => {
    const f = vi.fn(async () => Response.json({ detail: 'Point is outside dataset bounds' }, { status: 500 }))
    vi.stubGlobal('fetch', f)
    expect(await spotCloud(cap({ provider: 'gibs', collection: 'gibs-modis-terra' }), WATERLOO)).toBe('unknown')
    expect(f).not.toHaveBeenCalled()
    const off = cap({ collection: 'landsat-c2-l2', itemId: 'LC08_L2SP_019030_20261014_02_T2' })
    expect(await spotCloud(off, { lat: 43.4723, lon: -70.5449 })).toBe('unknown')
    const calls = f.mock.calls.length
    expect(await spotCloud(off, { lat: 43.4723, lon: -70.5449 })).toBe('unknown')
    expect(f.mock.calls.length).toBe(calls) // cached
  })

  it('rejects on abort', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const ctrl = new AbortController()
    const p = spotCloud(cap({ itemId: 'S2A_MSIL2A_20261027T162651_R040_T17TNJ_20261027T231305' }), WATERLOO, ctrl.signal)
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})
