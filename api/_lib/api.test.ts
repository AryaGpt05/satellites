/**
 * Server-side tests for the share page, the OG card and their helpers.
 *   npx vitest run --config scripts/backend-vitest.config.ts
 * Fixtures are real-shaped (Sentinel-2C over Waterloo); network calls are mocked except where the
 * OG renderer is exercised offline (default card, no image fetch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSharePage } from '../s.js'
import { niceLength } from './card.js'
import { buildCardSpec } from './cardSpec.js'
import { esc, jsonForScript, sharePageHtml } from './html.js'
import { bboxAround, cropPlan } from './imagery.js'
import { cardInputFromShare, description, headline, shareFromDeepLink, shareFromParams, shareFromRpc, summaryTitle, text } from './share.js'

/** The app's fallback link for the Sentinel-2C pass (src/ui/share/links.ts deepLink with the pass). */
const DEEP =
  'q=43.47%2C-80.54&n=Waterloo&p=60989-29892501&sat=Sentinel-2C&norad=60989&verdict=imaged&t=1793549661025&alt=795&off=5.3&hdg=195' +
  '&collection=sentinel-2-l2a&item=S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803&cloud=25&gsd=10&spot=clear'

/** [width, height] from a baseline or progressive JPEG's SOF marker, or null if it isn't a JPEG. */
function jpegSize(b: Uint8Array): [number, number] | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const m = b[i + 1]
    const len = (b[i + 2] << 8) | b[i + 3]
    if (m >= 0xc0 && m <= 0xc3) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]]
    i += 2 + len
  }
  return null
}

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
  it('reads the spot cloud class, and calls a picture clouded when cloud sits on the spot', () => {
    const spotCloud = shareFromRpc({ ...ROW, capture: { ...ROW.capture, spot: 'cloud' } })!
    expect(spotCloud.capture?.spot).toBe('cloud')
    const spec = buildCardSpec(cardInputFromShare(spotCloud, 'overflight.app'))
    // 25.5 % of the scene, cloud on the spot: the spot words, never "only cloud" (R2SH3).
    expect(spec.sub).toBe('Cloud over the spot itself.')
    expect(spec.plate.kind === 'image' && spec.plate.clouded?.segs[0].text).toBe('Cloud over the spot')
    expect(description(spotCloud)).toContain('Cloud covered the spot.')
    expect(shareFromRpc({ ...ROW, capture: { ...ROW.capture, spot: '<b>' } })?.capture?.spot).toBeUndefined()
    expect(buildCardSpec(cardInputFromShare(shareFromRpc(ROW)!, 'overflight.app')).sub).toBeUndefined()
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
    expect(shareFromParams(new URLSearchParams('place=W&lat=1&lon=1&verdict=imaged&item=S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803&spot=cloud'))?.capture?.spot).toBe('cloud')
    expect(shareFromParams(new URLSearchParams('place=W&lat=1&lon=1&verdict=imaged&item=S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803&spot=x'))?.capture?.spot).toBeUndefined()
  })
  it('reads a pass from the app’s fallback deep link (R2SH2)', () => {
    const s = shareFromDeepLink(new URLSearchParams(DEEP))!
    expect(s).toMatchObject({ placeLabel: 'Waterloo', lat: 43.47, lon: -80.54, norad: 60989, satName: 'Sentinel-2C', verdict: 'imaged', tClosest: 1793549661025 })
    expect(s.pass).toMatchObject({ altitudeKm: 795, offNadirDeg: 5.3, headingDeg: 195 })
    expect(s.capture).toMatchObject({ collection: 'sentinel-2-l2a', itemId: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803', cloudCoverPct: 25, gsdM: 10, spot: 'clear' })
    // Coarsened, label screened, and only with a verdict and a satellite.
    expect(shareFromDeepLink(new URLSearchParams('q=43.4723,-80.5449&n=Waterloo&norad=60989&verdict=imaged'))).toMatchObject({ lat: 43.47, lon: -80.54 })
    expect(shareFromDeepLink(new URLSearchParams('q=43.47,-80.54&n=12%20King%20St&norad=60989&verdict=could'))?.placeLabel).toBe('43.47°N 80.54°W')
    expect(shareFromDeepLink(new URLSearchParams('q=43.47,-80.54&n=Waterloo'))).toBeNull()
    expect(shareFromDeepLink(new URLSearchParams('q=43.47,-80.54&n=Waterloo&verdict=imaged'))).toBeNull()
    expect(shareFromDeepLink(new URLSearchParams('q=43.47,-80.54&n=Waterloo&norad=60989&verdict=owned'))).toBeNull()
  })
})

describe('copy', () => {
  it('writes the headline and description in the product voice', () => {
    const s = shareFromRpc(ROW)!
    expect(headline(s)).toBe('Sentinel-2C photographed Waterloo.')
    expect(description(s)).toBe(
      'Sentinel-2C crossed 795 km above Waterloo at 11:21 EST on Sun 1 Nov 2026. It was looking 5.3° off nadir. Cloud cover: 26%. What watched you this week?',
    )
    expect(headline({ ...s, verdict: 'could', satName: 'SkySat-C3' })).toBe('SkySat-C3 passed within view of Waterloo.')
    expect(headline({ ...s, satName: undefined })).toBe('NORAD 60989 photographed Waterloo.')
    expect(description({ ...s, verdict: 'could', satName: 'SkySat-C3', pass: { ...s.pass, headingDeg: 192 } })).toContain(
      "SkySat-C3 passed within view of Waterloo at 11:21 EST on Sun 1 Nov 2026, moving south. It could have pointed here. Its operator doesn't say whether it did. What watched you this week?",
    )
  })
})

describe('card spec', () => {
  it('prints local time, the credit, the invitation and the clouded line', () => {
    const s = shareFromRpc(ROW)!
    const spec = buildCardSpec(cardInputFromShare(s, 'overflight.app'))
    expect(spec.stamp).toBe('Sun 1 Nov 2026 · 11:21 EST')
    expect(spec.verdictLabel).toBe('Photographed')
    expect(spec.footLeft).toBe('See what watched you')
    expect(spec.plate.kind === 'image' && spec.plate.credit.segs[0].text).toBe('Contains modified Copernicus Sentinel data 2026')
    expect(spec.readouts.map((r) => `${r.label} ${r.value}${r.unit ? ` ${r.unit}` : ''}`)).toEqual(['Altitude 795 km', 'Off-nadir 5.3°', 'Pixel 10 m'])
    const cloudy = buildCardSpec(cardInputFromShare({ ...s, capture: { ...s.capture!, cloudCoverPct: 86 } }, ''))
    expect(cloudy.sub).toBe('Mostly cloud: 86% of the scene.')
    expect(cloudy.plate.kind === 'image' && cloudy.plate.clouded?.segs[0].text).toBe('Mostly cloud · 86%')
    const overcast = buildCardSpec(cardInputFromShare({ ...s, capture: { ...s.capture!, cloudCoverPct: 93 } }, ''))
    expect(overcast.sub).toBe('Clouded over. It saw only cloud.')
    expect(overcast.plate.kind === 'image' && overcast.plate.clouded?.segs[0].text).toBe('Clouded over · 93%')
    expect(description({ ...s, capture: { ...s.capture!, cloudCoverPct: 81 } })).toContain('It saw mostly cloud (81%). What watched you this week?')
    expect(description({ ...s, capture: { ...s.capture!, cloudCoverPct: 93 } })).toContain('It saw only cloud (93%).')
    const landsat = buildCardSpec(cardInputFromShare({ ...s, capture: { collection: 'landsat-c2-l2', itemId: 'LC09_L2SP_018030_20261031_02_T1' } }, ''))
    expect(landsat.plate.kind === 'image' && landsat.plate.credit.segs[0].text).toBe('Landsat: USGS / NASA')
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
    expect(body).toContain('<meta property="og:image" content="https://overflight.app/api/og?id=ab3d5f7h&#38;v=3">')
    expect(body).toContain('<meta property="og:image:type" content="image/jpeg">')
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
    const missingBody = await missing.text()
    expect(missingBody).toContain('url=/"')
    // The static default card is a PNG.
    expect(missingBody).toContain('<meta property="og:image" content="https://overflight.app/og-default.png">')
    expect(missingBody).toContain('<meta property="og:image:type" content="image/png">')
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

  it('unfurls an address-bar link as the place, coarsened to 0.01°', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const res = await handleSharePage(new Request('https://overflight.app/api/s?q=43.4723,-80.5449&n=Waterloo'))
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toContain('<meta property="og:title" content="What watched Waterloo this week">')
    expect(body).toContain('kind=place&#38;place=Waterloo&#38;lat=43.47&#38;lon=-80.54')
    expect(body).toContain('<meta property="og:image:type" content="image/jpeg">')
    expect(body).toContain(String.raw`location.replace("/?q=43.47%2C-80.54\u0026n=Waterloo")`)
    expect(body).not.toContain('43.4723')
    expect(fetch).not.toHaveBeenCalled()
    // A street address is never printed: the coordinates stand in.
    const addr = await (await handleSharePage(new Request('https://overflight.app/api/s?q=43.4723,-80.5449&n=123%20King%20St'))).text()
    expect(addr).toContain('What watched 43.47°N 80.54°W this week')
  })

  it('unfurls a fallback pass link as that pass, with its own card (R2SH2)', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const res = await handleSharePage(new Request(`https://overflight.app/api/s?${DEEP}`))
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toContain('<meta property="og:title" content="Sentinel-2C photographed Waterloo.">')
    expect(body).toContain('<meta property="og:description" content="Sentinel-2C crossed 795 km above Waterloo at 11:14 EST on Sun 1 Nov 2026, moving south.')
    const image = /<meta property="og:image" content="([^"]+)">/.exec(body)![1].replace(/&#38;/g, '&')
    const card = new URL(image)
    expect(card.pathname).toBe('/api/og')
    expect(Object.fromEntries(card.searchParams)).toEqual({
      place: 'Waterloo',
      lat: '43.47',
      lon: '-80.54',
      sat: 'Sentinel-2C',
      norad: '60989',
      verdict: 'imaged',
      t: '1793549661025',
      alt: '795',
      off: '5.3',
      hdg: '195',
      collection: 'sentinel-2-l2a',
      item: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
      cloud: '25',
      gsd: '10',
      spot: 'clear',
      v: '3',
    })
    expect(body).toContain('<meta property="og:image:type" content="image/jpeg">')
    expect(body).toContain('<meta property="og:image:alt" content="Sentinel-2C photographed Waterloo.">')
    // People land on the same pass in the app; the canonical keeps q, n, p and the pass keys.
    const canonical = new URL(/<link rel="canonical" href="([^"]+)">/.exec(body)![1].replace(/&#38;/g, '&'))
    expect(canonical.searchParams.get('q')).toBe('43.47,-80.54')
    expect(canonical.searchParams.get('p')).toBe('60989-29892501')
    expect(canonical.searchParams.get('norad')).toBe('60989')
    expect(canonical.searchParams.get('t')).toBe('1793549661025')
    expect(body).toContain(String.raw`location.replace("/?q=43.47%2C-80.54\u0026n=Waterloo\u0026p=60989-29892501\u0026sat=Sentinel-2C`)
    expect(fetch).not.toHaveBeenCalled()
    // A bare place link still gets the default card; summary links are unchanged.
    const bare = await (await handleSharePage(new Request('https://overflight.app/api/s?q=43.47,-80.54&n=Waterloo&p=60989-29892501'))).text()
    expect(bare).toContain('<meta property="og:title" content="What watched Waterloo this week">')
    expect(bare).toContain('kind=place&#38;place=Waterloo')
    const sum = await (await handleSharePage(new Request('https://overflight.app/api/s?q=43.47,-80.54&n=Waterloo&sv=4&sc=31,220,1544,66&sw=1793678400000'))).text()
    expect(sum).toContain('<meta property="og:title" content="4 satellites photographed Waterloo in detail this week">')
    expect(sum).toContain('kind=summary')
  })

  it('renders the page template with every required tag', () => {
    const html = sharePageHtml({ title: 'T', description: 'D', canonical: 'https://a/s/x', image: 'https://a/i.png', imageAlt: 'A', redirect: '/?s=x' })
    for (const tag of ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card', 'twitter:image', 'canonical']) expect(html).toContain(tag)
  })
})

describe('og card', () => {
  it('renders the default card as a 1200×630 JPEG under 250 KB with no network (R2SH4)', async () => {
    // Pass-through spy: @vercel/og may load its own wasm via fetch; the card itself must not
    // reach any remote host.
    const fetch = vi.spyOn(globalThis, 'fetch')
    const { handleOg } = (await import('../og.tsx' as string)) as { handleOg: (r: Request) => Promise<Response> }
    const res = await handleOg(new Request('https://overflight.app/api/og'))
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(jpegSize(buf)).toEqual([1200, 630])
    expect(buf.byteLength).toBeLessThan(250_000)
    const remote = fetch.mock.calls.map((c) => String(c[0] instanceof Request ? c[0].url : c[0])).filter((u) => /^https?:/.test(u))
    expect(remote).toEqual([])
    fetch.mockRestore()
  })

  it('draws a fallback pass link’s card from its parameters (R2SH2)', async () => {
    // No archive: the plate falls back to the pass geometry, the panel still names the pass.
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    const page = await handleSharePage(new Request(`https://overflight.app/api/s?${DEEP}`))
    const image = /<meta property="og:image" content="([^"]+)">/.exec(await page.text())![1].replace(/&#38;/g, '&')
    const q = new URL(image).searchParams
    const spec = buildCardSpec(cardInputFromShare(shareFromParams(q)!, 'overflight.app'))
    expect(`${spec.lead} ${spec.place}${spec.tail}`).toBe('Sentinel-2C photographed Waterloo.')
    expect(spec.coords).toBe('43.47°N 80.54°W')
    const { handleOg } = (await import('../og.tsx' as string)) as { handleOg: (r: Request) => Promise<Response> }
    const res = await handleOg(new Request(image))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(jpegSize(new Uint8Array(await res.arrayBuffer()))).toEqual([1200, 630])
    vi.unstubAllGlobals()
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

/**
 * vercel.json `routes` (share SH7), simulated: `vercel dev` can't evaluate `has`, so this walks the
 * route list the way the edge does (src anchored, `has` conditions as anchored regexes, `continue`
 * routes collect headers, the first other match wins, `handle: filesystem` marks where static files
 * and functions are served) for the requests that matter.
 */
describe('vercel.json routes', () => {
  interface Route {
    src?: string
    dest?: string
    headers?: Record<string, string>
    continue?: boolean
    handle?: string
    has?: { type: string; key: string; value?: string }[]
  }
  const routes = async (): Promise<Route[]> => {
    const { readFile } = await import('node:fs/promises')
    return (JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8')) as { routes: Route[] }).routes
  }
  const anchored = (re: string) => new RegExp(`^${re.replace(/^\^/, '').replace(/\$$/, '')}$`)
  /** Where a request lands before the filesystem phase ('filesystem' if no route claims it), and the headers it collected. */
  async function resolve(url: string, ua: string, phase: 'before' | 'after' = 'before') {
    const u = new URL(url, 'https://overflight.app')
    const list = await routes()
    const fsAt = list.findIndex((r) => r.handle === 'filesystem')
    const scope = phase === 'before' ? list.slice(0, fsAt) : list.slice(fsAt + 1)
    const headers: Record<string, string> = {}
    for (const r of scope) {
      const m = r.src ? anchored(r.src).exec(u.pathname) : null
      if (!m) continue
      const ok = (r.has ?? []).every((c) => {
        const v = c.type === 'query' ? u.searchParams.get(c.key) : c.type === 'header' && c.key === 'user-agent' ? ua : null
        return v !== null && (c.value === undefined || anchored(c.value).test(v))
      })
      if (!ok) continue
      Object.assign(headers, r.headers)
      if (r.continue) continue
      // Named and numbered groups substitute into dest ($id, $1), as on the edge.
      const dest = r.dest?.replace(/\$(\w+)/g, (_, k: string) => (/^\d+$/.test(k) ? m[Number(k)] : m.groups?.[k]) ?? '') ?? null
      return { dest, headers }
    }
    return { dest: 'filesystem', headers }
  }
  const BOT = 'Mozilla/5.0 (compatible; Twitterbot/1.0)'
  const IMESSAGE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0'
  const PERSON = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

  it('sends link unfurlers of an address-bar link to the place page, and people to the app', async () => {
    expect((await resolve('/?q=43.472,-80.545&n=Waterloo', BOT)).dest).toBe('/api/s')
    expect((await resolve('/?q=43.472,-80.545&n=Waterloo', IMESSAGE)).dest).toBe('/api/s')
    expect((await resolve('/?q=43.472,-80.545&n=Waterloo', PERSON)).dest).toBe('filesystem')
    expect((await resolve('/', BOT)).dest).toBe('filesystem') // the root card: static index.html + og-default.png
    expect((await resolve('/s/ab3d5f7h', PERSON)).dest).toBe('/api/s?id=ab3d5f7h')
  })

  it('falls back to the SPA for app paths only, after the filesystem', async () => {
    expect((await resolve('/about', PERSON, 'after')).dest).toBe('/index.html')
    expect((await resolve('/api/og', PERSON, 'after')).dest).toBe('filesystem')
    expect((await resolve('/missing.png', PERSON, 'after')).dest).toBe('filesystem')
  })

  it('keeps the security headers and never marks unhashed textures immutable', async () => {
    const page = await resolve('/', PERSON)
    expect(page.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(page.headers['Referrer-Policy']).toBeTruthy()
    expect((await resolve('/assets/index-abc123.js', PERSON)).headers['Cache-Control']).toContain('immutable')
    const tex = (await resolve('/textures/earth-day-4k.webp', PERSON)).headers['Cache-Control']
    expect(tex).toContain('max-age=86400')
    expect(tex).not.toContain('immutable')
  })
})
