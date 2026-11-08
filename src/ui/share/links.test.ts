import { describe, expect, it } from 'vitest'
import { DEEP_LINK_PASS_KEYS, POST_MAX, deepLink, postText, roundCoord, roundedPlace, shareLink, xIntentUrl } from './links'

describe('share links', () => {
  it('rounds coordinates to ~1 km', () => {
    expect(roundCoord(43.4723)).toBe(43.47)
    expect(roundCoord(-80.5449)).toBe(-80.54)
    expect(roundedPlace(43.4777, -80.5451)).toEqual({ lat: 43.48, lon: -80.55 })
  })
  it('builds the fallback deep link with rounded coordinates', () => {
    const url = deepLink('https://overflight.app', 'Waterloo', 43.4723, -80.5449, '60989-29892501')
    expect(url).toBe('https://overflight.app/?q=43.47%2C-80.54&n=Waterloo&p=60989-29892501')
    expect(url).not.toContain('43.4723')
  })
  it('carries the pass itself in the fallback link, rounded (R2SH2)', () => {
    const url = deepLink('https://overflight.app', 'Waterloo', 43.4723, -80.5449, '60989-29892501', {
      norad: 60989,
      satName: 'Sentinel-2C',
      verdict: 'imaged',
      tClosest: 1793549661025.6,
      altitudeKm: 794.93,
      offNadirDeg: 5.2649,
      headingDeg: 194.6,
      capture: { collection: 'sentinel-2-l2a', itemId: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803', cloudCoverPct: 25.46, gsdM: 10, spot: 'clear' },
    })
    const q = new URL(url).searchParams
    expect(q.get('q')).toBe('43.47,-80.54')
    expect(Object.fromEntries(DEEP_LINK_PASS_KEYS.map((k) => [k, q.get(k)]))).toEqual({
      sat: 'Sentinel-2C',
      norad: '60989',
      verdict: 'imaged',
      t: '1793549661026',
      alt: '795',
      off: '5.3',
      hdg: '195',
      collection: 'sentinel-2-l2a',
      item: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
      cloud: '25',
      gsd: '10',
      spot: 'clear',
    })
    expect([...q.keys()]).toEqual(['q', 'n', 'p', ...DEEP_LINK_PASS_KEYS])
    expect(url).not.toContain('43.4723')
    // No capture, unknown geometry: only what is known travels.
    const bare = new URL(deepLink('https://o.app', 'Waterloo', 43.4723, -80.5449, 'x', { norad: 25544, satName: 'ISS (Zarya)', verdict: 'overhead', tClosest: 1 })).searchParams
    expect([...bare.keys()]).toEqual(['q', 'n', 'p', 'sat', 'norad', 'verdict', 't'])
  })
  it('builds the short share link', () => {
    expect(shareLink('https://overflight.app', 'abc123')).toBe('https://overflight.app/s/abc123')
  })
  it('writes precise post text with an invitation, and fits with a link', () => {
    const base = { satName: 'Sentinel-2C', placeLabel: 'Waterloo', altitudeKm: 795.4, localDay: 'Sun 1 Nov', localTime: '11:21' }
    const t = postText({ ...base, verdict: 'imaged', resolution: '10 m' })
    expect(t).toBe(
      'Sentinel-2C photographed Waterloo from 795 km up on Sun 1 Nov at 11:21 local. 10 m per pixel; this is the actual image.\n\nSomething photographed you this week too.',
    )
    const c = postText({ ...base, verdict: 'could', satName: 'WorldView Legion 4', altitudeKm: 520, localDay: 'Sat 31 Oct', localTime: '10:52' })
    expect(c).toBe(
      "WorldView Legion 4 passed within view of Waterloo on Sat 31 Oct at 10:52 local. It could have pointed here. Its operator doesn't say whether it did.\n\nWhat passed over you this week?",
    )
    expect(postText({ ...base, verdict: 'likely', satName: 'MetOp-B' })).toContain('MetOp-B swept over Waterloo')
    // Clouded words match the picture (R2SH3).
    expect(postText({ ...base, verdict: 'imaged', cloud: { pct: 93 } })).toContain('from 795 km up on Sun 1 Nov at 11:21 local. It saw only cloud.')
    expect(postText({ ...base, verdict: 'imaged', cloud: { pct: 81 } })).toContain('at 11:21 local. It saw mostly cloud (81%).')
    expect(postText({ ...base, verdict: 'imaged', cloud: { pct: 64, spot: 'cloud' } })).toContain('at 11:21 local. Cloud covered the spot.')
    expect(postText({ ...base, verdict: 'imaged', resolution: '10 m', cloud: { pct: 30, spot: 'clear' } })).toContain('10 m per pixel; this is the actual image.')
    for (const pct of [0, 64, 70, 81, 89.4]) expect(postText({ ...base, verdict: 'imaged', cloud: { pct, spot: 'cloud' } })).not.toContain('only cloud')
    // Every verdict, with a long satellite name and a long city, stays within 230 characters plus the link.
    for (const verdict of ['imaged', 'likely', 'could', 'overhead'] as const) {
      for (const placeLabel of ['Waterloo', 'Saint-Jean-sur-Richelieu', 'Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch, Wales']) {
        const p = postText({ ...base, verdict, placeLabel, satName: 'WorldView Legion 4', resolution: '10 m' })
        expect(p.length).toBeLessThanOrEqual(POST_MAX)
        expect(p.length + 1 + 23).toBeLessThanOrEqual(280)
      }
      expect(postText({ ...base, verdict })).toMatch(/\n\n(Something photographed you this week too\.|What passed over you this week\?)$/)
    }
  })
  it('encodes the X intent', () => {
    expect(xIntentUrl('a b', 'https://x.y/s/1')).toBe('https://x.com/intent/tweet?text=a%20b&url=https%3A%2F%2Fx.y%2Fs%2F1')
  })
})
