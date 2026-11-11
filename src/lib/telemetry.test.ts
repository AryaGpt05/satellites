import { afterEach, describe, expect, it, vi } from 'vitest'
import { cityLevelLabel } from './backend'
import {
  appVersion,
  _testing,
  buildBatches,
  cellOf,
  deviceClass,
  flush,
  referrerHost,
  regionLabel,
  scrubMessage,
  setEnricher,
  telemetryAllowed,
  track,
  utmOf,
} from './telemetry'
import { reportCounts, searchSource } from '@/app/telemetry'
import type { Pass, Place } from '@/types'

describe('opt-outs', () => {
  const live = { hostname: 'www.watched.earth', search: '' }
  it('sends from the live site', () => expect(telemetryAllowed(live)).toBe(true))
  it('never under automation (navigator.webdriver)', () => expect(telemetryAllowed({ ...live, webdriver: true })).toBe(false))
  it('never on dev builds', () => expect(telemetryAllowed({ ...live, dev: true })).toBe(false))
  it('only on the production hosts: never local builds or Vercel previews', () => {
    expect(telemetryAllowed({ ...live, hostname: 'watched.earth' })).toBe(true)
    for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'mac.local', 'overflight-git-x-dev-armaans-projects.vercel.app', 'evil.watched.earth.example'])
      expect(telemetryAllowed({ ...live, hostname })).toBe(false)
  })
  it('a tab opened with ?noanalytics=1 stays out after the URL changes', () => expect(telemetryAllowed({ ...live, search: '?q=1,2&n=x', optedOut: true })).toBe(false))
  it('never with ?noanalytics=1', () => {
    expect(telemetryAllowed({ ...live, search: '?noanalytics=1' })).toBe(false)
    expect(telemetryAllowed({ ...live, search: '?q=1,2&noanalytics=1' })).toBe(false)
    expect(telemetryAllowed({ ...live, search: '?noanalytics=10' })).toBe(true)
  })
  it('the e2e build flag only lifts the webdriver/host checks', () => {
    expect(telemetryAllowed({ hostname: 'localhost', webdriver: true, e2e: true })).toBe(true)
    expect(telemetryAllowed({ hostname: 'localhost', e2e: true, search: '?noanalytics=1' })).toBe(false)
    expect(telemetryAllowed({ hostname: 'localhost', e2e: true, dev: true })).toBe(false)
  })
  it('track is a no-op when off', () => {
    const t = _testing({ allowed: false, sender: vi.fn() })
    track('search', { label: 'Waterloo' })
    expect(t.queue()).toHaveLength(0)
  })
})

describe('coarsening', () => {
  it('0.1° cells in record_lookup format', () => {
    expect(cellOf(43.4723, -80.5449)).toBe('43.5,-80.5')
    expect(cellOf(-0.04, 0.02)).toBe('0.0,0.0')
    expect(cellOf(10, -179.97)).toBe('10.0,180.0')
    expect(cellOf(91, 0)).toBeUndefined()
    expect(cellOf(NaN, 0)).toBeUndefined()
  })
  const place = (label: string, sublabel?: string, source: Place['source'] = 'search', streetLevel?: boolean) => ({ label, sublabel, source, streetLevel })
  const region = (p: ReturnType<typeof place>, shared = false) => regionLabel(p, cityLevelLabel, { shared })
  it('a city keeps its region and country', () => expect(region(place('Waterloo', 'Ontario, Canada'))).toBe('Waterloo, Ontario, Canada'))
  it('a typed street address is saved as its city', () => {
    expect(region(place('200 University Ave W', 'Waterloo, Ontario, Canada'))).toBe('Waterloo, Ontario, Canada')
    expect(region(place('King Street North', 'Waterloo, Ontario, Canada'))).toBe('Waterloo, Ontario, Canada')
    expect(region(place('Rue de Rivoli', 'Paris, Île-de-France, France'))).toBe('Paris, Île-de-France, France')
  })
  it('postcodes and coordinates never survive', () => {
    expect(region(place('43.4723°N 80.5449°W'))).toBeUndefined()
    expect(region(place('Home', 'N2L 3G1, Waterloo, Ontario'))).toBe('Home, Waterloo, Ontario')
  })
  it('street results the geocoder flags are saved as their city, in any language', () => {
    for (const street of ['Kalverstraat', 'Drottninggatan', 'Königsallee', 'Nevsky Prospekt', 'Strøget', 'Broadway', 'Avenue des Champs-Élysées'])
      expect(region(place(street, 'Amsterdam, North Holland, Netherlands', 'search', true))).toBe('Amsterdam, North Holland, Netherlands')
  })
  it('the word-list backstop catches unflagged street names', () => {
    for (const street of ['Kalverstraat', 'Drottninggatan', 'Königsallee', 'Boulevard Saint-Germain', 'Nevsky Prospekt'])
      expect(region(place(street, 'Somewhere, Region, Country'))).toBe('Somewhere, Region, Country')
  })
  it('near me keeps the settlement the reverse geocoder named (label = city, sublabel = region)', () =>
    expect(region(place('Waterloo', 'Ontario, Canada', 'geolocation'))).toBe('Waterloo, Ontario, Canada'))
  it('a deep link that is not a share keeps no free text', () => {
    expect(region(place('my house', undefined, 'url'))).toBeUndefined()
    expect(region(place('Waterloo', undefined, 'url'), true)).toBe('Waterloo')
  })
  it('named places and cities named St. stay', () => {
    expect(region(place('Pyramids of Giza', 'Giza, Egypt'))).toBe('Pyramids of Giza, Giza, Egypt')
    expect(region(place('St. Louis', 'Missouri, United States'))).toBe('St. Louis, Missouri, United States')
  })
  it('device class from viewport + pointer', () => {
    expect(deviceClass(390, 844, true)).toBe('phone')
    expect(deviceClass(820, 1180, true)).toBe('tablet')
    expect(deviceClass(1440, 900, false)).toBe('desktop')
  })
  it('referrer host only, never our own', () => {
    expect(referrerHost('https://t.co/AbC123?x=1', 'www.watched.earth')).toBe('t.co')
    expect(referrerHost('https://www.reddit.com/r/space/comments/1', 'www.watched.earth')).toBe('reddit.com')
    expect(referrerHost('https://www.watched.earth/?q=43.47,-80.54', 'www.watched.earth')).toBeUndefined()
    expect(referrerHost('', 'x')).toBeUndefined()
    expect(referrerHost('not a url', 'x')).toBeUndefined()
  })
  it('utm tags, clipped', () => {
    expect(utmOf('?utm_source=x&utm_medium=social&utm_campaign=' + 'a'.repeat(80) + '&q=1')).toEqual({ utm_source: 'x', utm_medium: 'social', utm_campaign: 'a'.repeat(60) })
    expect(utmOf('?q=1')).toEqual({})
  })
  it('error messages lose URLs and coordinates', () => {
    const m = scrubMessage('Failed to fetch https://photon.komoot.io/reverse?lat=43.4723&lon=-80.5449 at 43.4723, -80.5449')!
    expect(m).not.toMatch(/https?:|43\.47|80\.54/)
    expect(m).toBe('Failed to fetch [url] at #, #')
    expect(scrubMessage('x'.repeat(500))).toHaveLength(200)
    expect(scrubMessage('  ')).toBeUndefined()
  })
})

describe('batching', () => {
  afterEach(() => vi.useRealTimers())

  it('chunks of ≤ 50 with dt = ms ago, empty props omitted', () => {
    const events = Array.from({ length: 120 }, (_, i) => ({ type: 'about_open' as const, t: 1000 + i, p: i ? { n: i } : {} }))
    const bodies = buildBatches(events, 2000, 'sid_abcdefghijklmnop', { device: 'phone' }).map((b) => JSON.parse(b))
    expect(bodies.map((b) => b.events.length)).toEqual([50, 50, 20])
    expect(bodies[0]).toMatchObject({ sid: 'sid_abcdefghijklmnop', ctx: { device: 'phone' } })
    expect(bodies[0].events[0]).toEqual({ type: 'about_open', dt: 1000 })
    expect(bodies[2].events[19]).toEqual({ type: 'about_open', dt: 881, p: { n: 119 } })
  })

  it('queues, flushes after 4 s, or at once at 20 events; sendBeacon on hide', () => {
    vi.useFakeTimers()
    const sent: [string, boolean][] = []
    const t = _testing({ allowed: true, sender: (b, beacon) => sent.push([b, beacon]), ctx: { device: 'desktop' }, sid: 'sid_abcdefghijklmnop' })
    track('search', { source: 'search', label: 'Waterloo, Ontario, Canada', cell: '43.5,-80.5' })
    expect(t.queue()).toHaveLength(1)
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(4000)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0][0]).events[0].p).toEqual({ source: 'search', label: 'Waterloo, Ontario, Canada', cell: '43.5,-80.5' })
    for (let i = 0; i < 20; i++) track('about_open')
    expect(sent).toHaveLength(2)
    track('lightbox_open')
    flush(true)
    expect(sent[2][1]).toBe(true)
  })

  it('drops undefined / non-finite props, counts every share press, enriches', () => {
    const sent: string[] = []
    _testing({ allowed: true, sender: (b) => sent.push(b), ctx: {}, sid: 'sid_abcdefghijklmnop' })
    setEnricher((_t, p) => (p.norad === 60989 ? { ...p, sat: 'Sentinel-2C' } : p))
    track('results', { sats: 3, ms: NaN, partial: undefined })
    track('share_action', { action: 'copy_image', norad: 60989 })
    track('share_action', { action: 'x', norad: 60989 }) // a second, separate press
    flush()
    const ev = JSON.parse(sent[0]).events
    expect(ev).toHaveLength(3)
    expect(ev[0].p).toEqual({ sats: 3 })
    expect(ev[1].p).toEqual({ action: 'copy_image', norad: 60989, sat: 'Sentinel-2C' })
  })

  it('never throws, even if the sender does', () => {
    _testing({ allowed: true, sender: () => { throw new Error('boom') }, ctx: {}, sid: 'sid_abcdefghijklmnop' })
    track('about_open')
    expect(() => flush()).not.toThrow()
  })
})

describe('derived events', () => {
  const pass = (norad: number, verdict: Pass['verdict'], captureId?: string) => ({ norad, verdict, captureId }) as Pass
  it('N satellites and K photos as the headline counts them', () => {
    const r = { passes: [pass(1, 'imaged', 'a'), pass(1, 'imaged', 'b'), pass(2, 'imaged', 'a'), pass(3, 'could'), pass(3, 'likely')], partial: true }
    expect(reportCounts(r)).toEqual({ sats: 3, photos: 2, passes: 5, partial: true, archive_failed: false })
  })
  it('search sources', () => {
    const p = (source: Place['source']) => ({ label: 'x', lat: 0, lon: 0, source }) as Place
    expect(searchSource({ place: p('search') })).toBe('search')
    expect(searchSource({ place: p('demo') })).toBe('example')
    expect(searchSource({ place: p('surprise') })).toBe('surprise')
    expect(searchSource({ place: p('pin') })).toBe('pin')
    expect(searchSource({ place: p('geolocation') })).toBe('near_me')
    expect(searchSource({ place: p('url') })).toBe('deep_link')
    expect(searchSource({ place: p('url'), shared: { id: 'abcdefgh', placeLabel: 'x', lat: 0, lon: 0 } })).toBe('share_link')
  })
})

describe('the geocoder flags street-level results (src/imagery/geocode.ts)', () => {
  const f = (properties: Record<string, string>) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [4.89, 52.37] }, properties }) as never
  it('streets, houses and buildings are street-level; cities and landmarks are not', async () => {
    const { photonToPlace } = await import('@/imagery/geocode')
    expect(photonToPlace(f({ name: 'Kalverstraat', osm_key: 'highway', osm_value: 'pedestrian', type: 'street', city: 'Amsterdam', country: 'Netherlands' }))?.streetLevel).toBe(true)
    expect(photonToPlace(f({ housenumber: '12', street: 'Damrak', city: 'Amsterdam', osm_key: 'place', osm_value: 'house', type: 'house' }))?.streetLevel).toBe(true)
    expect(photonToPlace(f({ name: 'Amsterdam', osm_key: 'place', osm_value: 'city', type: 'city', country: 'Netherlands' }))?.streetLevel).toBeUndefined()
    expect(photonToPlace(f({ name: 'Rijksmuseum', osm_key: 'tourism', osm_value: 'museum', type: 'house', city: 'Amsterdam' }))?.streetLevel).toBe(true)
  })
})

describe('record_lookup labels are city-only too (src/lib/backend.ts lookupLabel)', () => {
  it('street-level results are saved as their city', async () => {
    const { lookupLabel } = await import('./backend')
    expect(lookupLabel({ label: 'Kalverstraat', sublabel: 'Amsterdam, North Holland, Netherlands', streetLevel: true })).toBe('Amsterdam')
    expect(lookupLabel({ label: 'Rijksmuseum', sublabel: 'Amsterdam, Netherlands', streetLevel: true })).toBe('Amsterdam')
    expect(lookupLabel({ label: 'Damrak 12', sublabel: '1012 LG, Netherlands', streetLevel: true })).toBe('Netherlands')
    expect(lookupLabel({ label: 'Waterloo', sublabel: 'Ontario, Canada' })).toBe('Waterloo')
  })
})

describe('the build version comes from the page, not from the bundle', () => {
  const doc = (content: string | null) => ({ querySelector: (sel: string) => (sel === 'meta[name="app-version"]' && content !== null ? { getAttribute: () => content } : null) }) as unknown as Document
  it('reads index.html\'s <meta name="app-version">', () => {
    expect(appVersion(doc('77fad94'))).toBe('77fad94')
    expect(appVersion(doc('0.1.0'))).toBe('0.1.0')
  })
  it('is empty without the tag, for junk or the unfilled placeholder, or with no document at all', () => {
    expect(appVersion(doc(null))).toBe('')
    expect(appVersion(doc('__APP_VERSION__'))).toBe('')
    expect(appVersion(doc('<script>'))).toBe('')
    expect(appVersion(doc(''))).toBe('')
    expect(appVersion(undefined)).toBe('')
    expect(appVersion({} as Document)).toBe('')
  })
})

describe('the boot-time arrival record (src/app/telemetryDeps.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })
  const store = (init: Record<string, string> = {}, throws = false) => {
    const m = new Map(Object.entries(init))
    const no = () => { throw new Error('blocked') }
    return {
      getItem: throws ? no : (k: string) => m.get(k) ?? null,
      setItem: throws ? no : (k: string, v: string) => void m.set(k, v),
      removeItem: throws ? no : (k: string) => void m.delete(k),
      m,
    }
  }
  const boot = async (pathname: string, search: string, ss: ReturnType<typeof store>, referrer = '') => {
    vi.stubGlobal('location', { pathname, search, hostname: 'www.watched.earth' })
    vi.stubGlobal('document', { referrer })
    vi.stubGlobal('sessionStorage', ss)
    vi.doMock('@/state/store', () => ({ useApp: {} }))
    vi.doMock('@/engine/catalog', () => ({ getSatInfo: () => undefined }))
    return (await import('@/app/telemetryDeps')).arrival
  }
  it('?noanalytics=1 opts the tab out at boot, before the app rewrites the URL', async () => {
    const ss = store()
    expect((await boot('/', '?noanalytics=1', ss)).optedOut).toBe(true)
    expect(ss.m.get('watched.noanalytics')).toBe('1')
  })
  it('a /s/ share page with ?noanalytics=1 opts out too, and its referrer and UTM tags survive the redirect', async () => {
    const ss = store({ 'watched.via': JSON.stringify({ r: 'https://t.co/x', q: '?noanalytics=1&utm_source=x' }) })
    const a = await boot('/', '?s=abcdefgh', ss)
    expect(a).toMatchObject({ entry: 'share_link', optedOut: true, referrer: 'https://t.co/x', search: '?noanalytics=1&utm_source=x' })
    expect(ss.m.has('watched.via')).toBe(false)
  })
  it('blocked storage: the boot flag still opts out', async () => {
    expect((await boot('/', '?q=1,2&noanalytics=1', store({}, true))).optedOut).toBe(true)
    vi.resetModules()
    expect(await boot('/', '?q=1,2', store({}, true))).toMatchObject({ optedOut: false, entry: 'deep_link' })
  })
})
