import { afterEach, describe, expect, it, vi } from 'vitest'
import waterloo from './__fixtures__/photon-waterloo.json'
import tokyo from './__fixtures__/photon-tokyo.json'
import paris from './__fixtures__/photon-paris.json'
import kitchener from './__fixtures__/photon-kitchener-ontario.json'
import eiffel from './__fixtures__/photon-eiffel-tower.json'
import revWaterloo from './__fixtures__/photon-reverse-waterloo.json'
import revTokyo from './__fixtures__/photon-reverse-tokyo.json'
import revOcean from './__fixtures__/photon-reverse-ocean.json'
import {
  coordinateLabel,
  dedupePlaces,
  joinUnique,
  parseCoordinates,
  photonReverseToPlace,
  photonToPlace,
  reversePlace,
  searchPlaces,
  timeZoneAt,
  type PhotonResponse,
} from './geocode'
import type { Place } from '@/types'

const places = (r: unknown) => dedupePlaces((r as PhotonResponse).features.map((f) => photonToPlace(f)).filter((p): p is Place => !!p))
const labels = (ps: Place[]) => ps.map((p) => [p.label, p.sublabel ?? ''])

describe('Photon forward labels', () => {
  it('Waterloo: clean two-line labels, near-duplicates merged', () => {
    const ps = places(waterloo)
    expect(labels(ps)).toEqual([
      ['Waterloo', 'Iowa, United States'],
      ['Waterloo', 'Ontario, Canada'], // the city; the county of the same name 1 km away is merged
      ['Waterloo', 'Walloon Brabant, Belgium'], // district + town merged
      ['Waterloo', 'New York, United States'],
    ])
    const on = ps[1]
    expect(on.countryCode).toBe('ca')
    expect(on.source).toBe('search')
    expect(on.lat).toBeCloseTo(43.4652699)
    expect(on.lon).toBeCloseTo(-80.5222961)
  })

  it('Tokyo: accented duplicate merged; Japanese state kept as given', () => {
    expect(labels(places(tokyo))).toEqual([
      ['Tokyo', 'Japan'],
      ['Tokyo International Airport', 'Tokyo, Japan'],
      ['Tokyo Bay', 'Chiba Prefecture, Japan'],
      ['Tokyo Dome', 'Tokyo, 東京都, Japan'],
      ['Tokyo Kanjo', 'Sagamihara, Kanagawa Prefecture, Japan'],
    ])
  })

  it('Paris: city and its admin boundaries collapse to one', () => {
    expect(labels(places(paris))).toEqual([
      ['Paris', 'Île-de-France, France'],
      ['Paris', 'Texas, United States'],
      ['Paris', 'Kentucky, United States'],
      ['Paris', 'Arkansas, United States'],
    ])
  })

  it('never repeats the label in the sublabel', () => {
    for (const p of [...places(kitchener), ...places(eiffel)]) {
      expect(p.sublabel?.split(', ').map((s) => s.toLowerCase()) ?? []).not.toContain(p.label.toLowerCase())
    }
    expect(places(kitchener)[0]).toMatchObject({ label: 'Kitchener', sublabel: 'Ontario, Canada', countryCode: 'ca' })
    expect(places(eiffel)[0]).toMatchObject({ label: 'Eiffel Tower', sublabel: 'Paris, Île-de-France, France', countryCode: 'fr' })
  })

  it('joins parts without duplicates, case- and accent-insensitively', () => {
    expect(joinUnique(['Tokyo', 'TOKYO', 'Tōkyō', undefined, ' ', 'Japan'])).toBe('Tokyo, Japan')
    expect(joinUnique(['Paris', 'France'], ['paris'])).toBe('France')
    expect(joinUnique([undefined])).toBeUndefined()
  })

  it('labels address hits by street', () => {
    const p = photonToPlace({ geometry: { type: 'Point', coordinates: [-80.54, 43.47] }, properties: { housenumber: '200', street: 'University Avenue West', city: 'Waterloo', state: 'Ontario', country: 'Canada', countrycode: 'CA' } })
    expect(p).toMatchObject({ label: '200 University Avenue West', sublabel: 'Waterloo, Ontario, Canada' })
  })
})

describe('Photon reverse labels', () => {
  it('prefers the settlement over the nearest object (a tree called "Class of 1995")', () => {
    const f = (revWaterloo as unknown as PhotonResponse).features[0]
    expect(photonReverseToPlace(f, 43.4723, -80.5449)).toEqual({
      lat: 43.4723,
      lon: -80.5449,
      label: 'Waterloo',
      sublabel: 'Ontario, Canada',
      countryCode: 'ca',
      source: 'geolocation',
    })
  })
  it('Tokyo', () => {
    const f = (revTokyo as unknown as PhotonResponse).features[0]
    expect(photonReverseToPlace(f, 35.6762, 139.6503)).toMatchObject({ label: 'Tokyo', sublabel: 'Japan', countryCode: 'jp' })
  })
  it('names wilderness by its natural feature, not "Unorganized …"', () => {
    const p = photonReverseToPlace(
      { geometry: { type: 'Point', coordinates: [-92.04, 50.53] }, properties: { name: 'lac Seul', osm_key: 'natural', osm_value: 'water', city: 'Unorganized Kenora District', county: 'Kenora', state: 'Ontario', country: 'Canada', countrycode: 'CA' } },
      50.5,
      -92,
    )
    expect(p).toMatchObject({ label: 'lac Seul', sublabel: 'Ontario, Canada' })
  })
})

describe('coordinates', () => {
  it('formats coordinate labels with the shared formatter', () => {
    expect(coordinateLabel(43.4723, -80.5449)).toBe('43.4723°N 80.5449°W')
    expect(coordinateLabel(-33.8688, 151.2093)).toBe('33.8688°S 151.2093°E')
  })
  it('parses typed coordinates', () => {
    expect(parseCoordinates('43.4723, -80.5449')).toEqual({ lat: 43.4723, lon: -80.5449 })
    expect(parseCoordinates('43.4723 -80.5449')).toEqual({ lat: 43.4723, lon: -80.5449 })
    expect(parseCoordinates('43.4723°N 80.5449°W')).toEqual({ lat: 43.4723, lon: -80.5449 })
    expect(parseCoordinates('33.8688S,151.2093E')).toEqual({ lat: -33.8688, lon: 151.2093 })
    expect(parseCoordinates('91, 0')).toBeNull()
    expect(parseCoordinates('waterloo')).toBeNull()
    expect(parseCoordinates('10 Downing St')).toBeNull()
  })
})

describe('time zones', () => {
  it('looks up IANA zones offline', () => {
    expect(timeZoneAt(43.4723, -80.5449)).toBe('America/Toronto')
    expect(timeZoneAt(35.6762, 139.6503)).toBe('Asia/Tokyo')
    expect(timeZoneAt(51.5, 360 - 0.12)).toBe('Europe/London') // longitude wrapped
    expect(timeZoneAt(Number.NaN, 0)).toBe('UTC')
  })
})

describe('network', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('searchPlaces queries Photon in English, limit 6, and caches', async () => {
    const f = vi.fn(async () => Response.json(waterloo))
    vi.stubGlobal('fetch', f)
    const r = await searchPlaces('  Waterloo ')
    expect(r).toHaveLength(4)
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe('https://photon.komoot.io/api/?q=Waterloo&limit=6&lang=en')
    await searchPlaces('waterloo')
    expect(f).toHaveBeenCalledTimes(1)
    expect(await searchPlaces('w')).toEqual([])
  })

  it('reverse-geocodes typed coordinates', async () => {
    const f = vi.fn(async () => Response.json(revWaterloo))
    vi.stubGlobal('fetch', f)
    const r = await searchPlaces('43.4723, -80.5449')
    expect(r).toEqual([{ lat: 43.4723, lon: -80.5449, label: 'Waterloo', sublabel: 'Ontario, Canada', countryCode: 'ca', source: 'search' }])
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain('/reverse?lat=43.472300&lon=-80.544900&lang=en&limit=1')
  })

  it('reversePlace falls back to a coordinate label at sea or offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(revOcean)))
    expect(await reversePlace(30, -40)).toEqual({ lat: 30, lon: -40, label: '30.0000°N 40.0000°W', source: 'geolocation' })
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    expect((await reversePlace(43.4723, -80.5449)).label).toBe('43.4723°N 80.5449°W')
  })
})
