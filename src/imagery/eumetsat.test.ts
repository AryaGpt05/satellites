import { afterEach, describe, expect, it, vi } from 'vitest'
import { eumetsatCapabilitiesUrl, eumetsatFrameCandidates, eumetsatFrames, eumetsatWmsUrl, latestEumetsatFrame, parseTimeDimension } from './eumetsat'

const PARIS = { lat: 48.8566, lon: 2.3522 }
const DELHI = { lat: 28.6139, lon: 77.209 }
const T = (iso: string) => Date.parse(iso)
const hm = (ts: number[]) => ts.map((t) => new Date(t).toISOString().slice(11, 16))

// Verbatim from https://view.eumetsat.int/geoserver/mtg_fd/rgb_geocolour/ows?…GetCapabilities, 2026-11-11 05:37Z (trimmed).
const CAPS =
  '<Layer queryable="1" opaque="0"><Name>rgb_geocolour</Name><Title>Geo Colour RGB - MTG-I - 0 degree</Title>' +
  '<Dimension name="time" default="2026-11-11T05:10:00Z" units="ISO8601" nearestValue="1">2024-09-23T00:00:00.000Z/2026-11-11T05:10:00.000Z/PT10M</Dimension></Layer>'

describe('EUMETView URLs', () => {
  it('asks for a square around the place at one frame, lat first, with black for no data', () => {
    const u = new URL(eumetsatWmsUrl('mtg_fd:rgb_geocolour', T('2026-11-11T05:10:00Z'), PARIS, { halfSizeKm: 400, px: 640 }))
    expect(u.origin + u.pathname).toBe('https://view.eumetsat.int/geoserver/ows')
    const q = u.searchParams
    expect(q.get('layers')).toBe('mtg_fd:rgb_geocolour')
    expect(q.get('time')).toBe('2026-11-11T05:10:00Z')
    expect(q.get('crs')).toBe('EPSG:4326')
    expect(q.get('format')).toBe('image/jpeg')
    expect(q.get('bgcolor')).toBe('0x000000')
    expect(q.get('width')).toBe('640')
    expect(q.get('height')).toBe('640')
    const [s, w, n, e] = q.get('bbox')!.split(',').map(Number)
    expect(s).toBeLessThan(PARIS.lat)
    expect(n).toBeGreaterThan(PARIS.lat)
    expect(w).toBeLessThan(PARIS.lon)
    expect(e).toBeGreaterThan(PARIS.lon)
    expect((n - s) * 111.2).toBeCloseTo(800, -1) // 800 km tall
    expect(e - w).toBeGreaterThan(n - s) // and as wide on the ground: more degrees of longitude at 49°N
  })

  it('is one URL per frame, place and size (the browser keeps it for a week)', () => {
    const a = eumetsatWmsUrl('msg_iodc:ir108', T('2026-11-11T05:15:00Z'), DELHI, { halfSizeKm: 400, px: 176 })
    expect(eumetsatWmsUrl('msg_iodc:ir108', T('2026-11-11T05:15:00.900Z'), DELHI, { halfSizeKm: 400, px: 176 })).toBe(a)
    expect(eumetsatWmsUrl('msg_iodc:ir108', T('2026-11-11T05:30:00Z'), DELHI, { halfSizeKm: 400, px: 176 })).not.toBe(a)
  })

  it("reads a layer's own capabilities document", () => {
    expect(eumetsatCapabilitiesUrl('mtg_fd:rgb_geocolour')).toBe('https://view.eumetsat.int/geoserver/mtg_fd/rgb_geocolour/ows?service=WMS&version=1.3.0&request=GetCapabilities')
  })
})

describe('EUMETView frame lists', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('expands the time dimension to frames in the window, newest first', () => {
    expect(hm(parseTimeDimension(CAPS, T('2026-11-11T04:35:00Z'), T('2026-11-11T05:40:00Z')))).toEqual(['05:10', '05:00', '04:50', '04:40'])
    expect(parseTimeDimension('<ServiceExceptionReport/>', 0, Infinity)).toEqual([])
  })

  it('fetches a list once per layer and shares it', async () => {
    const now = T('2026-11-11T05:37:00Z')
    const f = vi.fn(async () => new Response(CAPS, { status: 200, headers: { 'content-type': 'text/xml' } }))
    vi.stubGlobal('fetch', f)
    const [a, b] = await Promise.all([eumetsatFrames('mtg_fd:rgb_geocolour', { now }), eumetsatFrames('mtg_fd:rgb_geocolour', { now: now + 60_000 })])
    expect(hm(a.slice(0, 2))).toEqual(['05:10', '05:00'])
    expect(b).toBe(a)
    expect(f).toHaveBeenCalledTimes(1)
    expect(a[a.length - 1]).toBeGreaterThanOrEqual(now - 3 * 3_600_000)
  })

  it('rejects when the service lists nothing, and asks again next time', async () => {
    const f = vi.fn(async () => new Response('<ServiceExceptionReport/>', { status: 200 }))
    vi.stubGlobal('fetch', f)
    const now = T('2026-11-11T05:37:00Z')
    await expect(eumetsatFrames('msg_iodc:nope', { now })).rejects.toThrow()
    const calls = f.mock.calls.length
    await expect(eumetsatFrames('msg_iodc:nope', { now })).rejects.toThrow()
    expect(f.mock.calls.length).toBeGreaterThan(calls)
  })
})

describe('EUMETView frame candidates', () => {
  afterEach(() => vi.unstubAllGlobals())
  const listed = ['12:00', '11:45', '11:30', '11:15', '11:00', '10:45'].map((t) => T(`2026-11-10T${t}:00Z`))

  it('takes the newest few frames', () => {
    expect(hm(eumetsatFrameCandidates({ layer: 'msg_iodc:ir108' }, DELHI, listed))).toEqual(['12:00', '11:45', '11:30', '11:15'])
    expect(hm(eumetsatFrameCandidates({ layer: 'msg_iodc:ir108' }, DELHI, listed, 2))).toEqual(['12:00', '11:45'])
  })

  it('skips the frames a daylight product masks: sunset over Delhi, 2026-11-10 (measured: whole at 11:30Z, 16 % masked at 11:45Z)', () => {
    expect(hm(eumetsatFrameCandidates({ layer: 'msg_iodc:rgb_naturalenhncd', minSunDeg: 6 }, DELHI, listed))).toEqual(['11:15'])
  })

  it('makes no request for a daylight product in the middle of the night', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const midnight = T('2026-11-10T19:00:00Z') // 00:30 in Delhi
    await expect(latestEumetsatFrame({ layer: 'msg_iodc:rgb_naturalenhncd', minSunDeg: 6 }, DELHI, { halfSizeKm: 400, px: 176 }, { now: midnight })).resolves.toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('shows nothing when the list cannot be read (a guessed time would be answered with its nearest frame)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(latestEumetsatFrame({ layer: 'mtg_fd:down' }, PARIS, { halfSizeKm: 400, px: 176 }, { now: T('2026-11-11T05:37:00Z') })).resolves.toBeNull()
  })
})
