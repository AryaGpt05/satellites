import { describe, expect, it } from 'vitest'
import { DEEP_LINK_PASS_KEYS, POST_CREDIT, POST_MAX, X_LINK, X_MAX, deepLink, postText, roundCoord, roundedPlace, shareLink, summaryLink, summaryPostText, xIntentUrl, xLength } from './links'

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
      'Sentinel-2C watched Waterloo from 795 km up on Sun 1 Nov at 11:21 local. 10 m per pixel; this is the actual image.\n\nSomething watched you this week too.\nvia @armaangupt0',
    )
    const c = postText({ ...base, verdict: 'could', satName: 'WorldView Legion 4', altitudeKm: 520, localDay: 'Sat 31 Oct', localTime: '10:52' })
    expect(c).toBe(
      "WorldView Legion 4 passed within view of Waterloo on Sat 31 Oct at 10:52 local. It could have pointed here. Its operator doesn't say whether it did.\n\nWhat passed over you this week?\nvia @armaangupt0",
    )
    expect(postText({ ...base, verdict: 'likely', satName: 'MetOp-B' })).toContain('MetOp-B swept over Waterloo')
    // Clouded words match the picture (R2SH3).
    expect(postText({ ...base, verdict: 'imaged', cloud: { pct: 93 } })).toContain('from 795 km up on Sun 1 Nov at 11:21 local. It saw only cloud.')
    expect(postText({ ...base, verdict: 'imaged', cloud: { pct: 81 } })).toContain('at 11:21 local. It saw mostly cloud (81%).')
    expect(postText({ ...base, verdict: 'imaged', cloud: { pct: 64, spot: 'cloud' } })).toContain('at 11:21 local. Cloud covered the spot.')
    expect(postText({ ...base, verdict: 'imaged', resolution: '10 m', cloud: { pct: 30, spot: 'clear' } })).toContain('10 m per pixel; this is the actual image.')
    for (const pct of [0, 64, 70, 81, 89.4]) expect(postText({ ...base, verdict: 'imaged', cloud: { pct, spot: 'cloud' } })).not.toContain('only cloud')
    // Never "photographed" in what people post (owner override: "watched").
    for (const verdict of ['imaged', 'likely', 'could', 'overhead'] as const) expect(postText({ ...base, verdict })).not.toMatch(/photographed/i)
  })

  it('ends every post with the credit on its own line, within 280 with the link (R3-14)', () => {
    const base = { satName: 'Sentinel-2C', placeLabel: 'Waterloo', altitudeKm: 795.4, localDay: 'Sun 1 Nov', localTime: '11:21' }
    const places = [
      'Waterloo',
      'Saint-Jean-sur-Richelieu',
      'Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch, Wales',
      // The longest label a share can carry (cityLevelLabel, 120 code points), and one X counts double (CJK).
      `${'Taumatawhakatangihangakoauauotamateaturipukakapikimaungahoronukupokaiwhenuakitanatahu, '.repeat(2)}`.slice(0, 120),
      '東京都千代田区丸の内一丁目東京駅前広場周辺の大きな公園と庭園',
    ]
    const posts: string[] = []
    for (const verdict of ['imaged', 'likely', 'could', 'overhead'] as const) {
      for (const placeLabel of places) {
        posts.push(postText({ ...base, verdict, placeLabel, satName: 'WorldView Legion 4', resolution: '10 m' }))
        posts.push(postText({ ...base, verdict, placeLabel, cloud: { pct: 93 } }))
      }
      // A short post keeps its invitation paragraph, then the credit on the very next line.
      expect(postText({ ...base, verdict })).toMatch(/\n\n(Something watched you this week too\.|What passed over you this week\?)\nvia @armaangupt0$/)
    }
    for (const n of [0, 1, 7, 256, 12_345]) {
      for (const placeLabel of places) {
        posts.push(summaryPostText({ placeLabel, satellites: n, photos: n * 3 }))
        posts.push(summaryPostText({ placeLabel, satellites: n, photos: 0, archiveDown: true }))
      }
    }
    for (const p of posts) {
      const lines = p.split('\n')
      expect(lines[lines.length - 1]).toBe(POST_CREDIT)
      expect(lines[lines.length - 2]).not.toBe('') // its own line, right under the last paragraph
      expect(xLength(p)).toBeLessThanOrEqual(POST_MAX)
      // As posted on X: the text, a newline, the t.co link.
      expect(xLength(p) + 1 + X_LINK).toBeLessThanOrEqual(X_MAX)
      expect(p.split(POST_CREDIT)).toHaveLength(2)
    }
    expect(xLength('abc')).toBe(3)
    expect(xLength('東京')).toBe(4)
    expect(xLength('“—”')).toBe(3)
  })

  it('writes the summary post in the results headline’s words (R3-13)', () => {
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: 256, photos: 31 })).toBe(
      '256 satellites watched Waterloo this week. 31 photos were made public.\n\nSomething watched you this week too.\nvia @armaangupt0',
    )
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: 1, photos: 1 })).toMatch(/^1 satellite watched Waterloo this week\. 1 photo was made public\.\n/)
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: 12, photos: 0 })).toMatch(/^12 satellites watched Waterloo this week\. No photos were made public\.\n/)
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: 12, photos: 4, partial: true })).toMatch(/^12 satellites watched Waterloo this week\. At least 4 photos were made public\.\n/)
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: 12, photos: 0, archiveDown: true })).toMatch(
      /^12 satellites watched Waterloo this week\. The image archives didn’t answer, so we can’t count the public photos right now\.\n/,
    )
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: 0, photos: 0 })).toBe(
      'No satellite we track watched Waterloo this week. No photos were made public.\n\nWhat passed over you this week?\nvia @armaangupt0',
    )
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: 1234, photos: 5678 })).toMatch(/^1,234 satellites watched Waterloo this week\. 5,678 photos were made public\./)
  })

  it('carries N, K and the photo state in the summary link', () => {
    const base = { label: 'Waterloo', lat: 43.4723, lon: -80.5449, satellites: 256, counts: { imaged: 31, likely: 220, could: 1544, overhead: 66 }, windowEnd: 1793678400000 }
    const q = new URL(summaryLink('https://www.watched.earth', base)).searchParams
    expect(Object.fromEntries(q)).toEqual({ q: '43.47,-80.54', n: 'Waterloo', sv: '256', sc: '31,220,1544,66', sw: '1793678400000' })
    expect(new URL(summaryLink('https://www.watched.earth', { ...base, archiveDown: true, partial: true })).searchParams.get('sa')).toBe('1')
    expect(new URL(summaryLink('https://www.watched.earth', { ...base, archiveDown: true, partial: true })).searchParams.get('sp')).toBeNull()
    expect(new URL(summaryLink('https://www.watched.earth', { ...base, partial: true })).searchParams.get('sp')).toBe('1')
  })

  it('puts the link on its own line after the credit in the X intent (R3-14)', () => {
    expect(xIntentUrl('a b', 'https://x.y/s/1')).toBe('https://x.com/intent/tweet?text=a%20b%0Ahttps%3A%2F%2Fx.y%2Fs%2F1')
    const text = postText({ verdict: 'imaged', satName: 'Sentinel-2C', placeLabel: 'Waterloo', altitudeKm: 795, localDay: 'Sun 1 Nov', localTime: '11:21', resolution: '10 m' })
    const intent = new URL(xIntentUrl(text, 'https://www.watched.earth/s/ab3d5f7h'))
    expect(intent.searchParams.get('url')).toBeNull()
    expect(intent.searchParams.get('text')!.endsWith('\nSomething watched you this week too.\nvia @armaangupt0\nhttps://www.watched.earth/s/ab3d5f7h')).toBe(true)
  })
})
