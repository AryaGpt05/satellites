import { afterEach, describe, expect, it, vi } from 'vitest'
import { cityLevelLabel } from './backend'
import {
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
  it('never on local hosts', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', 'mac.local', 'app.localhost']) expect(telemetryAllowed({ ...live, hostname })).toBe(false)
  })
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
  const place = (label: string, sublabel?: string, source: Place['source'] = 'search') => ({ label, sublabel, source })
  const region = (p: ReturnType<typeof place>) => regionLabel(p, cityLevelLabel)
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
  it('near me uses only the city from the reverse geocode', () => expect(region(place('Lester Street', 'Waterloo, Ontario, Canada', 'geolocation'))).toBe('Waterloo, Ontario, Canada'))
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

  it('drops undefined / non-finite props, dedupes a share fallback, enriches', () => {
    const sent: string[] = []
    _testing({ allowed: true, sender: (b) => sent.push(b), ctx: {}, sid: 'sid_abcdefghijklmnop' })
    setEnricher((_t, p) => (p.norad === 60989 ? { ...p, sat: 'Sentinel-2C' } : p))
    track('results', { sats: 3, ms: NaN, partial: undefined })
    track('share_action', { action: 'copy_image', norad: 60989 })
    track('share_action', { action: 'save_png', norad: 60989 }) // copy image fell back to a download
    flush()
    const ev = JSON.parse(sent[0]).events
    expect(ev).toHaveLength(2)
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
    expect(searchSource({ place: p('geolocation') })).toBe('near_me')
    expect(searchSource({ place: p('url') })).toBe('deep_link')
    expect(searchSource({ place: p('url'), shared: { id: 'abcdefgh', placeLabel: 'x', lat: 0, lon: 0 } })).toBe('share_link')
  })
})
