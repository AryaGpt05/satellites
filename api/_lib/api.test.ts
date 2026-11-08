/**
 * Server-side tests for the share page, the OG card and their helpers.
 *   npx vitest run --config scripts/backend-vitest.config.ts
 * Fixtures are real-shaped (Sentinel-2C over Waterloo); network calls are mocked except where the
 * OG renderer is exercised offline (default card, no image fetch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSharePage } from '../s.js'
import { niceLength } from './card.js'
import { esc, jsonForScript, sharePageHtml } from './html.js'
import { bboxAround, cropPlan } from './imagery.js'
import { description, headline, shareFromParams, shareFromRpc, text } from './share.js'

const ROW = {
  id: 'ab3d5f7h',
  placeLabel: 'Waterloo',
  lat: 43.47,
  lon: -80.54,
  norad: 60989,
  satName: 'Sentinel-2C',
  verdict: 'imaged',
  tClosest: 1793550074000,
  capture: {
    collection: 'sentinel-2-l2a',
    itemId: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
    platform: 'sentinel-2c',
    datetime: 1793549661000,
    cloudCoverPct: 25.5,
    gsdM: 10,
  },
  pass: { norad: 60989, tClosest: 1793550074000, altitudeKm: 795, offNadirDeg: 5.3, verdict: 'imaged' },
  views: 3,
}

describe('escaping', () => {
  it('escapes HTML and attribute metacharacters', () => {
    expect(esc(`<img src=x onerror="alert('x')">&`)).toBe('&#60;img src=x onerror=&#34;alert(&#39;x&#39;)&#34;&#62;&#38;')
  })
  it('makes JSON safe inside <script>', () => {
    const s = jsonForScript('</script><script>alert(1)</script>\u2028')
    expect(s).not.toMatch(/<|>|\u2028/)
    expect(JSON.parse(s)).toBe('</script><script>alert(1)</script>\u2028')
  })
})

describe('share parsing', () => {
  it('normalises the RPC row', () => {
    const s = shareFromRpc(ROW)
    expect(s).toMatchObject({ id: 'ab3d5f7h', placeLabel: 'Waterloo', verdict: 'imaged', norad: 60989 })
    expect(s?.capture?.collection).toBe('sentinel-2-l2a')
  })
  it('rejects unusable rows and unsafe capture ids', () => {
    expect(shareFromRpc(null)).toBeNull()
    expect(shareFromRpc({ ...ROW, verdict: 'owned', pass: { ...ROW.pass, verdict: 'owned' } })).toBeNull()
    expect(shareFromRpc({ ...ROW, lat: 120 })).toBeNull()
    expect(shareFromRpc({ ...ROW, capture: { ...ROW.capture, itemId: '../../x?y' } })?.capture).toBeUndefined()
  })
  it('strips control characters and caps length', () => {
    expect(text('a\u0000b\n  c', 10)).toBe('ab c')
    expect(text('x'.repeat(200), 10)).toHaveLength(10)
  })
  it('drops invisible bidi / zero-width characters and never splits a surrogate pair', () => {
    expect(text('Water‮oo​l⁦', 40)).toBe('Waterool')
    expect(text('line break', 40)).toBe('line break')
    const clipped = text(`${'a'.repeat(8)}🛰️🛰️🛰️`, 10)!
    expect(Array.from(clipped)).toHaveLength(10)
    expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
  it('builds a share from explicit params, coarsened to 0.01°', () => {
    const s = shareFromParams(new URLSearchParams('place=Waterloo&lat=43.47231&lon=-80.54492&verdict=could&sat=SkySat-C3&alt=397'))
    expect(s).toMatchObject({ lat: 43.47, lon: -80.54, verdict: 'could', satName: 'SkySat-C3' })
    expect(shareFromParams(new URLSearchParams('place=Waterloo&lat=abc&lon=1&verdict=could'))).toBeNull()
    expect(shareFromParams(new URLSearchParams('lat=1&lon=1&verdict=could'))).toBeNull()
  })
})

describe('copy', () => {
  it('writes the headline and description in the product voice', () => {
    const s = shareFromRpc(ROW)!
    expect(headline(s)).toBe('Sentinel-2C photographed Waterloo.')
    expect(description(s)).toBe(
      'Sentinel-2C crossed 795 km above Waterloo at 16:14 UTC on 1 Nov 2026. It was looking 5.3° off nadir. Cloud cover: 26%. See every satellite that passed over any place this week.',
    )
    expect(headline({ ...s, verdict: 'could', satName: 'SkySat-C3' })).toBe('SkySat-C3 passed within view of Waterloo.')
    expect(headline({ ...s, satName: undefined })).toBe('NORAD 60989 photographed Waterloo.')
    expect(description({ ...s, verdict: 'could', satName: 'SkySat-C3', pass: { ...s.pass, headingDeg: 192 } })).toContain(
      "SkySat-C3 passed within view of Waterloo at 16:21 UTC on 1 Nov 2026, moving south. It could have pointed here. We can't know whether it did.",
    )
  })
})

describe('crop plans', () => {
  it('matches the app’s Planetary Computer recipe for Sentinel-2', () => {
    const plan = cropPlan(shareFromRpc(ROW)!.capture!, 43.47, -80.54, 630)!
    expect(plan.metresPerPx).toBe(10)
    expect(plan.halfSizeKm).toBeCloseTo(3.15)
    expect(plan.url).toMatch(/^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/-80\.\d{6},43\.\d{6},-80\.\d{6},43\.\d{6}\/630x630\.png\?/)
    expect(plan.url).toContain('collection=sentinel-2-l2a&item=S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803&assets=visual&asset_bidx=visual%7C1%2C2%2C3&nodata=0')
  })
  it('refuses Earth Search ids (no server-side cropper)', () => {
    expect(cropPlan({ collection: 'sentinel-2-l2a', itemId: 'S2C_T17TNJ_20261101T161421_L2A' }, 43.47, -80.54, 630)).toBeNull()
  })
  it('uses lat,lon axis order for GIBS WMS 1.3.0', () => {
    const plan = cropPlan({ collection: 'gibs-modis-aqua', itemId: 'MODIS_Aqua_CorrectedReflectance_TrueColor@2026-11-02' }, 43.47, -80.54, 630)!
    const [s, w, n, e] = new URL(plan.url).searchParams.get('BBOX')!.split(',').map(Number)
    const [bw, bs, be, bn] = bboxAround(43.47, -80.54, plan.halfSizeKm)
    expect([s, w, n, e].map((v) => v.toFixed(3))).toEqual([bs, bw, bn, be].map((v) => v.toFixed(3)))
    expect(plan.url).toContain('TIME=2026-11-02')
  })
  it('rejects a GIBS id whose layer does not match its collection', () => {
    expect(cropPlan({ collection: 'gibs-modis-aqua', itemId: 'MODIS_Terra_CorrectedReflectance_TrueColor@2026-11-02' }, 0, 0, 630)).toBeNull()
  })
  it('picks round scale-bar lengths', () => {
    expect(niceLength(1.5)).toBe(1)
    expect(niceLength(4.4)).toBe(2)
    expect(niceLength(73)).toBe(50)
  })
})

describe('share page', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example-ref.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
    vi.stubEnv('SITE_URL', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  const req = (id: string) => new Request(`https://overflight.app/api/s?id=${encodeURIComponent(id)}`)

  it('serves Open Graph tags for a found share and hands people to the app', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(ROW), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const res = await handleSharePage(req('ab3d5f7h'))
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(body).toContain('<meta property="og:title" content="Sentinel-2C photographed Waterloo.">')
    expect(body).toContain('<meta property="og:image" content="https://overflight.app/api/og?id=ab3d5f7h&#38;v=1">')
    expect(body).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(body).toContain('<link rel="canonical" href="https://overflight.app/s/ab3d5f7h">')
    expect(body).toContain('<meta http-equiv="refresh" content="0; url=/?s=ab3d5f7h">')
    expect(body).toContain('location.replace("/?s=ab3d5f7h")')
    // Reads without counting a view.
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ p_id: 'ab3d5f7h', p_view: false })
  })

  it('escapes stored text', async () => {
    const evil = { ...ROW, placeLabel: '"><script>alert(1)</script>' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(evil), { status: 200 })))
    const body = await (await handleSharePage(req('ab3d5f7h'))).text()
    expect(body).not.toContain('<script>alert(1)')
    expect(body).toContain('&#34;&#62;&#60;script&#62;alert(1)')
  })

  it('404s unknown shares and malformed ids', async () => {
    const fetch = vi.fn(async () => new Response('null', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const missing = await handleSharePage(req('zzzzzzzz'))
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('url=/"')
    const junk = await handleSharePage(req('<x>'))
    expect(junk.status).toBe(404)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the link alive when the database is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('down'))))
    const res = await handleSharePage(req('ab3d5f7h'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('s-maxage=60')
    expect(await res.text()).toContain('/?s=ab3d5f7h')
  })

  it('renders the page template with every required tag', () => {
    const html = sharePageHtml({ title: 'T', description: 'D', canonical: 'https://a/s/x', image: 'https://a/i.png', imageAlt: 'A', redirect: '/?s=x' })
    for (const tag of ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card', 'twitter:image', 'canonical']) expect(html).toContain(tag)
  })
})

describe('og card', () => {
  it('renders the default card as a 1200×630 PNG with no network', async () => {
    // Pass-through spy: @vercel/og may load its own wasm via fetch; the card itself must not
    // reach any remote host.
    const fetch = vi.spyOn(globalThis, 'fetch')
    const { handleOg } = (await import('../og.tsx' as string)) as { handleOg: (r: Request) => Promise<Response> }
    const res = await handleOg(new Request('https://overflight.app/api/og'))
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Array.from(buf.slice(1, 4)).map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
    const view = new DataView(buf.buffer, buf.byteOffset)
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630])
    const remote = fetch.mock.calls.map((c) => String(c[0] instanceof Request ? c[0].url : c[0])).filter((u) => /^https?:/.test(u))
    expect(remote).toEqual([])
    fetch.mockRestore()
  })

  it('caches an uncroppable capture as final without asking any archive', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const { handleOg } = (await import('../og.tsx' as string)) as { handleOg: (r: Request) => Promise<Response> }
    const q = 'place=Waterloo&lat=43.47&lon=-80.54&verdict=imaged&sat=Sentinel-2C&collection=sentinel-2-l2a&item=S2C_T17TNJ_20261101T161421_L2A'
    const res = await handleOg(new Request(`https://overflight.app/api/og?${q}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('s-maxage=31536000')
    const remote = fetch.mock.calls.map((c) => String(c[0] instanceof Request ? c[0].url : c[0])).filter((u) => /^https?:/.test(u))
    expect(remote).toEqual([])
    fetch.mockRestore()
  })
})
