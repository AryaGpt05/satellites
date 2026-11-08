import { describe, expect, it } from 'vitest'
import { deepLink, postText, roundCoord, roundedPlace, shareLink, xIntentUrl } from './links'

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
  it('builds the short share link', () => {
    expect(shareLink('https://overflight.app', 'abc123')).toBe('https://overflight.app/s/abc123')
  })
  it('writes precise post text that fits with a link', () => {
    const t = postText({
      verdict: 'imaged',
      satName: 'Sentinel-2C',
      placeLabel: 'Waterloo',
      altitudeKm: 786.4,
      localDay: 'Sun 1 Nov',
      localTime: '11:21',
      resolution: '10 m',
    })
    expect(t).toBe('Sentinel-2C photographed Waterloo from 786 km up on Sun 1 Nov at 11:21 local, at 10 m per pixel. This is the actual image.')
    expect(t.length + 24).toBeLessThan(280)
    const c = postText({ verdict: 'could', satName: 'Legion 4', placeLabel: 'Waterloo', altitudeKm: 520, localDay: 'Sat 31 Oct', localTime: '10:52' })
    expect(c).toContain('It could have pointed here.')
  })
  it('encodes the X intent', () => {
    expect(xIntentUrl('a b', 'https://x.y/s/1')).toBe('https://x.com/intent/tweet?text=a%20b&url=https%3A%2F%2Fx.y%2Fs%2F1')
  })
})
