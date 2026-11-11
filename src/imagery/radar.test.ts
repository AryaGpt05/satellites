import { afterEach, describe, expect, it, vi } from 'vitest'
import s1Berlin from './__fixtures__/pc-s1-berlin.json'
import { placeInCrop, tonePlanForUrl } from '../../api/_lib/toneRender'
import { utmForward } from '../../api/_lib/utm'
import { isRadarUrl, radarCropUrl, RADAR_DB_MAX, RADAR_DB_MIN } from './radar'
import { radarStretch, toneRadar } from './radarTone'
import { _resetSearchTransport, dedupeCandidates, pcRadarItemToCandidate, searchRadar, type StacItem, type StacItemCollection } from './stac'

const BERLIN = { lat: 52.517, lon: 13.3889 }
const items = (s1Berlin as unknown as StacItemCollection).features
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const ITEM = 'S1D_IW_GRDH_1SDV_20261109T051629_20261109T051654_005386_00A455_rtc'

describe('radar crop URL', () => {
  const url = radarCropUrl(ITEM, 'vv', BERLIN, { halfSizeKm: 10, px: 1000 })
  const [, box, px] = /\/bbox\/([^/]+)\/(\d+)x\d+\.png\?/.exec(url)!
  const b = box.split(',').map(Number)

  it('is cut on the place’s UTM grid in whole 10 m pixels, 20 km across, the place at its centre', () => {
    expect(url).toContain('collection=sentinel-1-rtc')
    expect(url).toContain('coord_crs=EPSG:32633&dst_crs=EPSG:32633')
    expect(b[2] - b[0]).toBe(20_000)
    expect(b[3] - b[1]).toBe(20_000)
    for (const v of b) expect(v % 10).toBe(0)
    expect(Number(px)).toBe(1000)
    const [x, y] = utmForward(32633, BERLIN.lat, BERLIN.lon)
    expect(Math.abs((b[0] + b[2]) / 2 - x)).toBeLessThanOrEqual(10)
    expect(Math.abs((b[1] + b[3]) / 2 - y)).toBeLessThanOrEqual(10)
    const at = placeInCrop(url, BERLIN.lat, BERLIN.lon)!
    expect(Math.abs(at.fx - 0.5)).toBeLessThan(0.001)
    expect(Math.abs(at.fy - 0.5)).toBeLessThan(0.001)
  })

  it('asks for decibels of one polarisation, averaged 2 × 2 (20 m: the radar’s own resolution)', () => {
    const q = new URLSearchParams(url.split('?')[1])
    expect(q.get('assets')).toBe('vv')
    expect(q.get('expression')).toBe('where(vv>0.001,10*log10(vv),-30)')
    expect(q.get('rescale')).toBe(`${RADAR_DB_MIN},${RADAR_DB_MAX}`)
    expect(q.get('resampling')).toBe('average')
    const native = radarCropUrl(ITEM, 'hh', BERLIN, { halfSizeKm: 5, px: 1000 })
    expect(new URLSearchParams(native.split('?')[1]).get('resampling')).toBeNull()
    expect(native).toContain('assets=hh')
  })

  it('is recognised as radar, never as a photo to tone with a curve', () => {
    expect(isRadarUrl(url)).toBe(true)
    expect(isRadarUrl(url.replace('.png?', '.jpg?'))).toBe(true)
    expect(tonePlanForUrl(url)).toBeNull()
    expect(isRadarUrl(url.replace('sentinel-1-rtc', 'sentinel-2-l2a'))).toBe(false)
  })

  it('is lon/lat when asked (or beyond UTM’s latitudes)', () => {
    const geo = radarCropUrl(ITEM, 'vv', BERLIN, { halfSizeKm: 40, px: 768, geographic: true })
    expect(geo).not.toContain('coord_crs')
    expect(geo).toContain('/768x768.png?')
    expect(radarCropUrl(ITEM, 'hh', { lat: 85, lon: 10 }, { halfSizeKm: 10, px: 1000 })).not.toContain('coord_crs')
  })
})

describe('radar tone', () => {
  /** A grey RGBA image of encoded values. */
  const img = (vals: number[]) => {
    const a = new Uint8ClampedArray(vals.length * 4)
    vals.forEach((v, i) => a.set([v, v, v, 255], i * 4))
    return a
  }
  const lum = (a: Uint8ClampedArray, i: number) => a[i * 4] + a[i * 4 + 1] + a[i * 4 + 2]

  it('stretches each image from its own dark to its own bright, monotonically', () => {
    const vals = Array.from({ length: 1000 }, (_, i) => 60 + Math.floor((i / 1000) * 140))
    const a = img(vals)
    expect(toneRadar(a, 1000, 1)).toBe(1)
    for (let i = 1; i < 1000; i++) expect(lum(a, i)).toBeGreaterThanOrEqual(lum(a, i - 1))
    expect(lum(a, 0)).toBeLessThan(80)
    expect(lum(a, 999)).toBeGreaterThan(600)
    // Never pure white; a faint ice cast (blue ≥ red) in the mid-tones.
    expect(a[999 * 4]).toBeLessThan(250)
    expect(a[500 * 4 + 2]).toBeGreaterThan(a[500 * 4])
  })

  it('never stretches a uniform scene (open sea) over less than 16 dB', () => {
    const steps16 = 16 / ((RADAR_DB_MAX - RADAR_DB_MIN) / 255)
    const hist = new Uint32Array(256)
    hist[40] = 500
    hist[44] = 500
    const [lo, hi] = radarStretch(hist)!
    expect(hi - lo).toBeGreaterThanOrEqual(steps16 - 1e-9)
    const a = img(Array.from({ length: 100 }, (_, i) => (i % 2 ? 40 : 44)))
    toneRadar(a, 100, 1)
    expect(Math.abs(lum(a, 0) - lum(a, 1))).toBeLessThan(100)
  })

  it('keeps no data black and says when there is none', () => {
    const a = img([0, 5, 30, 120, 220])
    expect(toneRadar(a, 5, 1)).toBeCloseTo(0.6)
    expect(Array.from(a.slice(0, 3))).toEqual([0, 0, 0])
    expect(Array.from(a.slice(4, 7))).toEqual([0, 0, 0])
    expect(lum(a, 2)).toBeGreaterThan(0)
    expect(toneRadar(img([0, 0, 3]), 3, 1)).toBe(0)
    expect(radarStretch(new Uint32Array(256))).toBeNull()
  })
})

describe('radar items', () => {
  it('converts a real RTC item: platform, NORAD, 20 m, no cloud, a crop on the grid', () => {
    const c = pcRadarItemToCandidate(items[0] as StacItem, BERLIN)!
    expect(c.capture.platform).toBe('sentinel-1d')
    expect(c.capture.norad).toBe(66315)
    expect(c.capture.collection).toBe('sentinel-1-rtc')
    expect(c.capture.gsdM).toBe(20)
    expect(c.capture.cloudCoverPct).toBeUndefined()
    expect(c.epsg).toBe(32633)
    expect(c.capture.footprint?.length).toBeGreaterThan(3)
    expect(isRadarUrl(c.capture.cropUrl({ halfSizeKm: 10, px: 1000 }))).toBe(true)
  })

  it('reads HH where the scene has no VV, and skips a scene with neither', () => {
    const hh = clone(items[0]) as StacItem
    hh.properties['sar:polarizations'] = ['HH', 'HV']
    hh.assets = { hh: { href: 'x' }, hv: { href: 'y' } }
    expect(pcRadarItemToCandidate(hh, BERLIN)!.capture.cropUrl({ halfSizeKm: 10, px: 1000 })).toContain('assets=hh')
    const none = clone(items[0]) as StacItem
    none.properties['sar:polarizations'] = ['VH']
    expect(pcRadarItemToCandidate(none, BERLIN)).toBeUndefined()
  })

  it('keeps one image per overflight (adjacent slices of a datatake are one)', () => {
    const next = clone(items[0]) as StacItem
    next.id = next.id.replace('20261109T051629', '20261109T051654')
    next.properties.datetime = '2026-11-09T05:17:07Z'
    const cands = [...items, next].map((it) => pcRadarItemToCandidate(it as StacItem, BERLIN)!).filter(Boolean)
    const out = dedupeCandidates(cands, BERLIN)
    expect(out.map((c) => c.capture.datetime)).toEqual([...out.map((c) => c.capture.datetime)].sort((a, b) => b - a))
    expect(out).toHaveLength(items.length)
  })
})

describe('searchRadar', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    _resetSearchTransport()
  })

  it('asks Planetary Computer for sentinel-1-rtc at the place, by GET, and returns captures newest first', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(s1Berlin), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const caps = await searchRadar(BERLIN, Date.UTC(2026, 10, 4), Date.UTC(2026, 10, 11, 5))
    expect(caps).toHaveLength(4)
    expect(caps[0].datetime).toBeGreaterThan(caps[3].datetime)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(init?.method ?? 'GET').toBe('GET')
    expect(new URL(url).searchParams.get('collections')).toBe('sentinel-1-rtc')
  })

  it('rejects when the archive is down (the engine keeps the radar passes as geometry says)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(searchRadar(BERLIN, Date.UTC(2026, 10, 4), Date.UTC(2026, 10, 11))).rejects.toThrow()
  })
})

describe('radar ramp', () => {
  it('is built from the design’s own tokens (ink-2, ice)', async () => {
    const { palette } = await import('@/ui/system/palette')
    const { RADAR_INK, RADAR_ICE } = await import('../../api/_lib/radar')
    const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
    expect(hex(RADAR_INK)).toBe(palette.ink2)
    expect(hex(RADAR_ICE)).toBe(palette.ice)
  })
})
