import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Capture } from '@/types'
import { maskFromResponse, maskCellAt } from '../../api/_lib/tone'
import { maskNpy } from '../../api/_lib/npyTesting'
import { classifyQaArea, classifyQaPixel, classifyScl, classifySclArea, spotCheck, spotCloud, spotFromMask, spotMaskQuery } from './cloud'

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

describe('the mask query', () => {
  it('reads SCL for Sentinel-2 and qa_pixel for Landsat over the photo square around the rounded place; nothing for GIBS', () => {
    const url = spotMaskQuery(cap({}), WATERLOO)!.url
    // ±5 km around 43.47, -80.54 (the place rounded to 0.01°), 64 px, raw classes as numpy.
    expect(url).toMatch(/\/item\/bbox\/-80\.6\d+,43\.42\d+,-80\.4\d+,43\.51\d+\/64x64\.npy\?/)
    expect(url).toContain('collection=sentinel-2-l2a&item=S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803&assets=SCL')
    expect(spotMaskQuery(cap({}), { lat: 43.4701, lon: -80.5401 })!.url).toBe(url) // same rounded place, same mask
    expect(spotMaskQuery(cap({ collection: 'landsat-c2-l2', itemId: 'LC09_L2SP_019030_20261022_02_T1' }), WATERLOO)!.url).toContain('&assets=qa_pixel')
    expect(spotMaskQuery(cap({ provider: 'gibs', collection: 'gibs-viirs-noaa20', itemId: 'L@2026-11-07' }), WATERLOO)).toBeNull()
    expect(spotMaskQuery(cap({ provider: 'earth-search', itemId: 'S2B_T17TNJ_20261106T161753_L2A' }), WATERLOO)).toBeNull()
  })

  it('classifies the 1 km box around the exact place by majority', () => {
    const url = spotMaskQuery(cap({}), WATERLOO)!.url
    const probe = maskFromResponse(url, maskNpy(64, 64, () => 4))
    const at = maskCellAt(probe, WATERLOO.lon, WATERLOO.lat)
    const [cx, cy] = [at % 64, Math.floor(at / 64)]
    // Cloud only within 2 cells of the place: the 1 km box (~6 cells across) is mostly cloud.
    const near = maskFromResponse(url, maskNpy(64, 64, (x, y) => (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2 ? 9 : 4)))
    expect(spotFromMask(near, WATERLOO)).toBe('cloud')
    // The same cloud 10 cells away: clear at the place.
    const far = maskFromResponse(url, maskNpy(64, 64, (x, y) => (Math.abs(x - cx - 10) <= 2 && Math.abs(y - cy) <= 2 ? 9 : 4)))
    expect(spotFromMask(far, WATERLOO)).toBe('clear')
    // No data around the place: unknown.
    const edge = maskFromResponse(url, maskNpy(64, 64, () => 4, (x) => x > cx + 8))
    expect(spotFromMask(edge, WATERLOO)).toBe('unknown')
    expect(classifyQaArea([21824, 21824, 22280])).toBe('clear')
    expect(classifyQaArea([22280, 22280, 21824])).toBe('cloud')
  })
})

describe('spotCheck', () => {
  afterEach(() => vi.unstubAllGlobals())
  const npyResponse = (body: Uint8Array<ArrayBuffer>) => new Response(body, { headers: { 'content-type': 'application/x-binary' } })

  it('reads the spot and the clear share from one cached mask', async () => {
    // Left quarter cloud (SCL 9), the rest vegetation: the place (centre) is clear, 75 % of the square is.
    const f = vi.fn(async () => npyResponse(maskNpy(64, 64, (x) => (x < 16 ? 9 : 4))))
    vi.stubGlobal('fetch', f)
    const c = cap({ itemId: 'S2B_MSIL2A_20261106T161449_R140_T17TNJ_20261106T195148' })
    expect(await spotCheck(c, WATERLOO)).toEqual({ spot: 'clear', clearFraction: 0.75 })
    expect(await spotCloud(c, WATERLOO)).toBe('clear')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('answers unknown for GIBS without a request, and when the place is off the scene', async () => {
    const f = vi.fn(async () => Response.json({ detail: 'does not intersect' }, { status: 404 }))
    vi.stubGlobal('fetch', f)
    expect(await spotCloud(cap({ provider: 'gibs', collection: 'gibs-modis-terra' }), WATERLOO)).toBe('unknown')
    expect(f).not.toHaveBeenCalled()
    const off = cap({ collection: 'landsat-c2-l2', itemId: 'LC08_L2SP_019030_20261014_02_T2' })
    expect(await spotCheck(off, { lat: 43.4723, lon: -70.5449 })).toEqual({ spot: 'unknown' })
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
