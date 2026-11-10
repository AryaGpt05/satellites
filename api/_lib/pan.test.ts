import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handlePan } from '../pan.js'
import { PAN_PX, panQuery, parsePanQuery, processBody } from './pan.js'

const NOW = Date.UTC(2026, 10, 10, 20)
const T = Date.UTC(2026, 10, 3, 6, 46)
/** The app's Landsat crop over Palm Jumeirah (EPSG:32640), as pcCropUrlAt cuts it. */
const BOX = [304845, 2771175, 319845, 2786175]

describe('parsePanQuery', () => {
  const q = (s: string) => new URLSearchParams(s)
  it('accepts an app crop', () => {
    expect(parsePanQuery(q(panQuery(BOX, 32640, T)), NOW)).toEqual({ box: BOX, crs: 32640, t: T })
  })
  it('refuses anything else', () => {
    expect(parsePanQuery(q(panQuery([304845, 2771175, 324845, 2791175], 32640, T)), NOW)).toBe('bbox size')
    expect(parsePanQuery(q(panQuery([304846, 2771175, 319846, 2786175], 32640, T)), NOW)).toBe('bbox grid')
    expect(parsePanQuery(q('bbox=1,2,3&crs=32640&t=1'), NOW)).toBe('bbox')
    expect(parsePanQuery(q(panQuery(BOX, 4326, T)), NOW)).toBe('crs')
    expect(parsePanQuery(q(panQuery(BOX, 32640, NOW + 2 * 3_600_000)), NOW)).toBe('t')
    expect(parsePanQuery(q(panQuery(BOX, 32640, NOW - 200 * 86_400_000)), NOW)).toBe('t')
  })
  it('asks for B08 of that capture hour only, on the crop grid 1:1', () => {
    const b = processBody({ box: BOX as [number, number, number, number], crs: 32640, t: T })
    expect(b.input.bounds.properties.crs).toBe('http://www.opengis.net/def/crs/EPSG/0/32640')
    expect(b.input.data[0].type).toBe('landsat-ot-l1')
    expect(Date.parse(b.input.data[0].dataFilter.timeRange.to) - Date.parse(b.input.data[0].dataFilter.timeRange.from)).toBe(2 * 3_600_000)
    expect(b.output.width).toBe(PAN_PX)
    expect(b.evalscript).toContain('"B08"')
  })
})

describe('handlePan', () => {
  const url = (s = panQuery(BOX, 32640, T)) => new Request(`https://www.watched.earth/api/pan?${s}`)
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    process.env.CDSE_CLIENT_ID = 'id'
    process.env.CDSE_CLIENT_SECRET = 'secret'
    fetchMock = vi.fn(async (u: string) =>
      String(u).includes('/token') ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 600 })) : new Response(png, { headers: { 'content-type': 'image/png' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete process.env.CDSE_CLIENT_ID
    delete process.env.CDSE_CLIENT_SECRET
  })

  it('answers the pan PNG, cached at the edge, and reuses its token', async () => {
    const r1 = await handlePan(url())
    expect(r1.status).toBe(200)
    expect(r1.headers.get('cache-control')).toContain('s-maxage=31536000')
    expect(new Uint8Array(await r1.arrayBuffer())).toEqual(png)
    const r2 = await handlePan(url())
    expect(r2.status).toBe(200)
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/token')).length
    expect(tokenCalls).toBe(1)
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/process'))!
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' })
  })

  it('refuses a crop the app never cuts, without calling CDSE', async () => {
    const r = await handlePan(url('bbox=0,0,50000,50000&crs=32640&t=1'))
    expect(r.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says so without a body when CDSE has nothing, refuses, or is not configured', async () => {
    fetchMock.mockImplementation(async (u: string) => (String(u).includes('/token') ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 600 })) : new Response('{}', { status: 400 })))
    expect((await handlePan(url())).status).toBe(404)
    fetchMock.mockImplementation(async (u: string) => (String(u).includes('/token') ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 600 })) : new Response('', { status: 503 })))
    const bad = await handlePan(url())
    expect(bad.status).toBe(502)
    expect(bad.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300')
  })
})
