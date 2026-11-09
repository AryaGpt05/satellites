import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capture, Pass, Place } from '@/types'
import {
  _resetBackendCache,
  backendConfigured,
  cityLevelLabel,
  createShare,
  getShare,
  getStats,
  parseShare,
  parseStats,
  platformDisplayName,
  recordLookup,
  sharePayload,
} from './backend'

// Test fixtures only (real-shaped: Sentinel-2C over Waterloo, 1 Nov 2026).
const URL_ = 'https://example-ref.supabase.co'
const KEY = 'sb_publishable_test'
const PLACE: Place = { label: 'Waterloo', sublabel: 'Ontario, Canada', countryCode: 'CA', lat: 43.4723, lon: -80.5449, source: 'search' }
const PASS: Pass = {
  id: '60989-29892501',
  norad: 60989,
  tClosest: 1793550073893,
  tStart: 1793550055378,
  tEnd: 1793550092409,
  groundDistanceKm: 73.26,
  offNadirDeg: 5.26,
  elevationDeg: 84.08,
  azimuthDeg: 103.9,
  altitudeKm: 794.9,
  groundSpeedKmS: 6.714,
  headingDeg: 194.6,
  node: 'descending',
  sunElevationDeg: 31.06,
  inSwath: true,
  inFieldOfRegard: true,
  verdict: 'imaged',
  track: [{ t: 1793550073893, lat: 43.5, lon: -80.4, altKm: 794.9 }],
  captureId: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
}
const CAPTURE: Capture = {
  id: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
  provider: 'planetary-computer',
  collection: 'sentinel-2-l2a',
  itemId: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
  platform: 'sentinel-2c',
  norad: 60989,
  datetime: 1793549661025,
  cloudCoverPct: 25.456536,
  gsdM: 10,
  cropUrl: () => '',
}

type FetchArgs = [string, RequestInit]
function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(impl(url, init)))
  vi.stubGlobal('fetch', fn)
  return fn
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const bodyOf = (fn: ReturnType<typeof mockFetch>, i = 0) => JSON.parse(String((fn.mock.calls[i] as FetchArgs)[1].body))

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', URL_)
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', KEY)
  _resetBackendCache()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('configuration', () => {
  it('is a silent no-op when env vars are missing', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetch = mockFetch(() => json(null))
    expect(backendConfigured()).toBe(false)
    await expect(recordLookup(PLACE)).resolves.toBeUndefined()
    await expect(createShare({ placeLabel: 'Waterloo', lat: 43.47, lon: -80.54, pass: PASS })).resolves.toBeNull()
    await expect(getShare('ab3d5f7h')).resolves.toBeNull()
    await expect(getStats()).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a non-https URL', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://insecure.example')
    expect(backendConfigured()).toBe(false)
  })
})

describe('recordLookup', () => {
  it('posts a coarsened, city-level lookup with the publishable key', async () => {
    const fetch = mockFetch(() => new Response(null, { status: 204 }))
    await recordLookup(PLACE)
    const [url, init] = fetch.mock.calls[0] as FetchArgs
    expect(url).toBe(`${URL_}/rest/v1/rpc/record_lookup`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).apikey).toBe(KEY)
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    expect(init.keepalive).toBeUndefined()
    expect(bodyOf(fetch)).toEqual({ p_lat: 43.5, p_lon: -80.5, p_country: 'ca', p_label: 'Waterloo' })
  })

  it('never rejects on network failure or server error', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    await expect(recordLookup(PLACE)).resolves.toBeUndefined()
    mockFetch(() => json({ message: 'invalid coordinates' }, 400))
    await expect(recordLookup(PLACE)).resolves.toBeUndefined()
  })

  it('skips invalid coordinates without a request', async () => {
    const fetch = mockFetch(() => json(null))
    await recordLookup({ ...PLACE, lat: Number.NaN })
    await recordLookup({ ...PLACE, lon: 181 })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('cityLevelLabel', () => {
  it('keeps settlement names and drops street addresses and coordinates', () => {
    expect(cityLevelLabel({ label: 'Waterloo', sublabel: 'Ontario, Canada' })).toBe('Waterloo')
    expect(cityLevelLabel({ label: '200 University Ave W', sublabel: 'Waterloo, Ontario, Canada' })).toBe('Waterloo')
    expect(cityLevelLabel({ label: '43.4723°N 80.5449°W' })).toBeUndefined()
  })
})

describe('createShare', () => {
  it('sends the pass without its track and returns the id and link', async () => {
    const fetch = mockFetch(() => json('ab3d5f7h'))
    const res = await createShare({ placeLabel: 'Waterloo', lat: 43.4723, lon: -80.5449, pass: PASS, capture: CAPTURE })
    expect(res?.id).toBe('ab3d5f7h')
    expect(res?.url).toMatch(/\/s\/ab3d5f7h$/)
    const { payload } = bodyOf(fetch)
    expect(payload.pass.track).toBeUndefined()
    expect(payload.pass.norad).toBe(60989)
    expect(payload.satName).toBe('Sentinel-2C') // derived from the capture platform
    expect(payload.capture).toEqual({
      collection: 'sentinel-2-l2a',
      itemId: CAPTURE.itemId,
      provider: 'planetary-computer',
      platform: 'sentinel-2c',
      datetime: CAPTURE.datetime,
      cloudCoverPct: CAPTURE.cloudCoverPct,
      gsdM: 10,
    })
    expect(JSON.stringify(payload).length).toBeLessThan(8192)
  })

  it('prefers an explicit satName', () => {
    expect(sharePayload({ placeLabel: 'Waterloo', lat: 1, lon: 1, pass: PASS, satName: 'SENTINEL-2C' })?.satName).toBe('SENTINEL-2C')
  })

  it('returns null when rate-limited, offline, or given a malformed id', async () => {
    mockFetch(() => json({ code: 'P0001', message: 'rate limited' }, 400))
    expect(await createShare({ placeLabel: 'Waterloo', lat: 43.47, lon: -80.54, pass: PASS })).toBeNull()
    mockFetch(() => Promise.reject(new TypeError('offline')))
    expect(await createShare({ placeLabel: 'Waterloo', lat: 43.47, lon: -80.54, pass: PASS })).toBeNull()
    mockFetch(() => json('<script>'))
    expect(await createShare({ placeLabel: 'Waterloo', lat: 43.47, lon: -80.54, pass: PASS })).toBeNull()
  })

  it('validates input before any request', async () => {
    const fetch = mockFetch(() => json('ab3d5f7h'))
    expect(await createShare({ placeLabel: '  ', lat: 1, lon: 1, pass: PASS })).toBeNull()
    expect(await createShare({ placeLabel: 'x', lat: 91, lon: 1, pass: PASS })).toBeNull()
    expect(await createShare({ placeLabel: 'x', lat: 1, lon: 1, pass: { ...PASS, verdict: 'nope' as Pass['verdict'] } })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('times out instead of hanging', async () => {
    vi.useFakeTimers()
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const p = createShare({ placeLabel: 'Waterloo', lat: 43.47, lon: -80.54, pass: PASS })
    await vi.advanceTimersByTimeAsync(10_001)
    await expect(p).resolves.toBeNull()
  })
})

describe('getShare', () => {
  const ROW = {
    id: 'ab3d5f7h',
    createdAt: 1793600000000,
    placeLabel: 'Waterloo',
    lat: 43.47,
    lon: -80.54,
    norad: 60989,
    satName: 'Sentinel-2C',
    verdict: 'imaged',
    tClosest: 1793550074000,
    capture: { collection: 'sentinel-2-l2a', itemId: CAPTURE.itemId, platform: 'sentinel-2c', datetime: 1793549661000, cloudCoverPct: 25.5, gsdM: 10 },
    pass: { norad: 60989, tClosest: 1793550074000, altitudeKm: 795, verdict: 'imaged' },
    views: 3,
  }

  it('parses the RPC result', async () => {
    const fetch = mockFetch(() => json(ROW))
    const s = await getShare('AB3D5F7H ')
    expect(bodyOf(fetch)).toEqual({ p_id: 'ab3d5f7h' })
    expect(s).toMatchObject({ id: 'ab3d5f7h', placeLabel: 'Waterloo', lat: 43.47, lon: -80.54, norad: 60989, tClosest: 1793550074000, verdict: 'imaged' })
    expect(s?.capture?.itemId).toBe(CAPTURE.itemId)
  })

  it('does not hit the network for a malformed id', async () => {
    const fetch = mockFetch(() => json(ROW))
    expect(await getShare('../../etc')).toBeNull()
    expect(await getShare('')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns null for unknown shares and junk', async () => {
    mockFetch(() => json(null))
    expect(await getShare('zzzzzzzz')).toBeNull()
    expect(parseShare({ ...ROW, lat: 'x' })).toBeNull()
    expect(parseShare({ ...ROW, id: 'nope' })).toBeNull()
  })

  it('re-validates the stored pass and capture instead of trusting them', () => {
    // 1e2000 parses to Infinity; a hand-made row could carry anything.
    const s = parseShare({
      ...ROW,
      pass: { norad: 60989, altitudeKm: Infinity, headingDeg: 99999, offNadirDeg: -5, groundDistanceKm: 73, node: 'sideways', inSwath: 'yes', extra: '<x>' },
      capture: { ...ROW.capture, cloudCoverPct: 140, gsdM: 0 },
    })
    expect(s?.pass).toEqual({ norad: 60989, groundDistanceKm: 73 })
    expect(s?.capture?.cloudCoverPct).toBeUndefined()
    expect(s?.capture?.gsdM).toBeUndefined()
    expect(parseShare({ ...ROW, capture: { ...ROW.capture, collection: 'maxar-secret' } })?.capture).toBeUndefined()
  })
})

describe('sharePayload', () => {
  it('truncates long labels by code point, never splitting a surrogate pair', () => {
    const label = `${'a'.repeat(118)}🛰️🛰️`
    const p = sharePayload({ placeLabel: label, lat: 1, lon: 1, pass: PASS })!
    const out = p.placeLabel as string
    expect(Array.from(out).length).toBeLessThanOrEqual(120)
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    expect(sharePayload({ placeLabel: 'Waterloo', lat: 1, lon: 1, pass: PASS })!.placeLabel).toBe('Waterloo')
  })
  it('keeps the week\'s N on the pass for the card headline (owner: "7 satellites watched Waterloo.")', () => {
    const pass = (i: Partial<Parameters<typeof sharePayload>[0]>) => sharePayload({ placeLabel: 'Waterloo', lat: 1, lon: 1, pass: PASS, ...i })!.pass as Record<string, unknown>
    expect(pass({ satellites: 7.4 }).weekSatellites).toBe(7)
    expect(pass({}).weekSatellites).toBeUndefined()
    expect(pass({ satellites: 0 }).weekSatellites).toBeUndefined()
    expect(pass({ satellites: Number.NaN }).weekSatellites).toBeUndefined()
  })
})

describe('getStats', () => {
  const STATS = {
    total: 65,
    last24h: 65,
    places: [{ cell: '-33.9,151.2', lat: -33.9, lon: 151.2, label: 'Sydney', countryCode: 'au', count: 60 }, { bogus: true }],
    cells: [[-33.9, 151.2, 60], [20, 20, 3], [999, 0, 1], 'x'],
    computedAt: 1794115851505,
  }

  it('parses and drops malformed entries', () => {
    const s = parseStats(STATS)
    expect(s?.total).toBe(65)
    expect(s?.places).toHaveLength(1)
    expect(s?.cells).toEqual([
      [-33.9, 151.2, 60],
      [20, 20, 3],
    ])
    expect(parseStats({ total: 'many' })).toBeNull()
  })

  it('shares one request between callers and caches for a minute', async () => {
    const fetch = mockFetch(() => json(STATS))
    const [a, b] = await Promise.all([getStats(), getStats()])
    expect(a).toEqual(b)
    await getStats()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failure', async () => {
    const fetch = mockFetch(() => json({ message: 'down' }, 503))
    expect(await getStats()).toBeNull()
    await Promise.resolve()
    mockFetch(() => json(STATS))
    expect((await getStats())?.total).toBe(65)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('platformDisplayName', () => {
  it('names archive platforms like people do', () => {
    expect(platformDisplayName('sentinel-2c')).toBe('Sentinel-2C')
    expect(platformDisplayName('landsat-9')).toBe('Landsat 9')
    expect(platformDisplayName('noaa-20')).toBe('NOAA-20')
    expect(platformDisplayName('aqua')).toBe('Aqua')
    expect(platformDisplayName(undefined)).toBeUndefined()
  })
})
