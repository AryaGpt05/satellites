import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pass } from '@/types'
import { gibsWmsUrl, worldviewUrl } from './endpoints'
import { GEO_SAFE_LAG_MS, geoFrameTime, geoImageUrl, gibsTime, utcDate, weatherCandidates } from './gibs'
import { measureNoData } from './image'

const WATERLOO = { lat: 43.4723, lon: -80.5449 }
const TOKYO = { lat: 35.6762, lon: 139.6503 }

function pass(over: Partial<Pass>): Pass {
  const t = Date.parse('2026-11-07T18:20:00Z')
  return {
    id: 'p',
    norad: 43013,
    tClosest: t,
    tStart: t - 60_000,
    tEnd: t + 60_000,
    groundDistanceKm: 200,
    offNadirDeg: 15,
    elevationDeg: 70,
    azimuthDeg: 90,
    altitudeKm: 830,
    groundSpeedKmS: 6.6,
    headingDeg: 190,
    node: 'ascending',
    sunElevationDeg: 25,
    inSwath: true,
    inFieldOfRegard: true,
    verdict: 'likely',
    track: [],
    ...over,
  }
}

describe('GIBS WMS URLs', () => {
  it('uses lat,lon axis order in BBOX for EPSG:4326 / WMS 1.3.0', () => {
    const url = new URL(gibsWmsUrl('VIIRS_NOAA20_CorrectedReflectance_TrueColor', '2026-11-07', WATERLOO, { halfSizeKm: 150, px: 512 }))
    const q = url.searchParams
    expect(url.origin + url.pathname).toBe('https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi')
    expect(q.get('SERVICE')).toBe('WMS')
    expect(q.get('REQUEST')).toBe('GetMap')
    expect(q.get('VERSION')).toBe('1.3.0')
    expect(q.get('CRS')).toBe('EPSG:4326')
    expect(q.get('STYLES')).toBe('')
    expect(q.get('FORMAT')).toBe('image/jpeg')
    expect(q.get('WIDTH')).toBe('512')
    expect(q.get('HEIGHT')).toBe('512')
    expect(q.get('TIME')).toBe('2026-11-07')
    const [minLat, minLon, maxLat, maxLon] = q.get('BBOX')!.split(',').map(Number)
    // Values verified against a real request that returned the right region
    expect(minLat).toBeCloseTo(42.12332, 4)
    expect(minLon).toBeCloseTo(-82.40375, 4)
    expect(maxLat).toBeCloseTo(44.82128, 4)
    expect(maxLon).toBeCloseTo(-78.68605, 4)
    expect(minLat).toBeLessThan(maxLat)
    // a km-square box: longitude span is wider by 1/cos(lat)
    expect((maxLon - minLon) / (maxLat - minLat)).toBeCloseTo(1 / Math.cos((WATERLOO.lat * Math.PI) / 180), 3)
  })

  it('clamps latitude at the poles', () => {
    const q = new URL(gibsWmsUrl('L', '2026-11-07', { lat: 89.9, lon: 0 }, { halfSizeKm: 300, px: 64 })).searchParams
    const [, , maxLat] = q.get('BBOX')!.split(',').map(Number)
    expect(maxLat).toBe(90)
  })

  it('links to Worldview with the same layer and day', () => {
    const u = new URL(worldviewUrl('MODIS_Terra_CorrectedReflectance_TrueColor', '2026-11-07', TOKYO))
    expect(u.host).toBe('worldview.earthdata.nasa.gov')
    expect(u.searchParams.get('l')).toBe('MODIS_Terra_CorrectedReflectance_TrueColor,Coastlines_15m')
    expect(u.searchParams.get('t')).toBe('2026-11-07')
    expect(u.searchParams.get('v')!.split(',')).toHaveLength(4)
  })
})

describe('geostationary frame time', () => {
  afterEach(() => vi.useRealTimers())
  const now = Date.parse('2026-11-08T03:45:00Z')

  it('rounds older instants down to the 10-minute mark', () => {
    expect(geoFrameTime(Date.parse('2026-11-07T18:07:59Z'), now)).toBe(Date.parse('2026-11-07T18:00:00Z'))
    expect(geoFrameTime(Date.parse('2026-11-07T18:10:00Z'), now)).toBe(Date.parse('2026-11-07T18:10:00Z'))
  })

  it('holds recent instants back by the safety lag', () => {
    expect(GEO_SAFE_LAG_MS).toBe(70 * 60_000)
    expect(geoFrameTime(now, now)).toBe(Date.parse('2026-11-08T02:30:00Z'))
    expect(geoFrameTime(now - 10 * 60_000, now)).toBe(Date.parse('2026-11-08T02:30:00Z'))
    expect(geoFrameTime(now + 3_600_000, now)).toBe(Date.parse('2026-11-08T02:30:00Z'))
  })

  it('builds GOES / Himawari URLs with an ISO frame time and daily layers with a date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const goes = new URL(geoImageUrl('gibs-goes-east', WATERLOO, Date.parse('2026-11-07T17:03:00Z'), { halfSizeKm: 300, px: 512 })).searchParams
    expect(goes.get('LAYERS')).toBe('GOES-East_ABI_GeoColor')
    expect(goes.get('TIME')).toBe('2026-11-07T17:00:00Z')
    const live = new URL(geoImageUrl('gibs-goes-west', WATERLOO, now, { halfSizeKm: 300, px: 512 })).searchParams
    expect(live.get('TIME')).toBe('2026-11-08T02:30:00Z')
    const hima = new URL(geoImageUrl('gibs-himawari', TOKYO, Date.parse('2026-11-08T01:00:00Z'), { halfSizeKm: 150, px: 256 })).searchParams
    expect(hima.get('LAYERS')).toBe('Himawari_AHI_Band3_Red_Visible_1km')
    expect(hima.get('TIME')).toBe('2026-11-08T01:00:00Z')
    const daily = new URL(geoImageUrl('gibs-viirs-noaa21', TOKYO, Date.parse('2026-11-07T04:30:00Z'), { halfSizeKm: 150, px: 256 })).searchParams
    expect(daily.get('TIME')).toBe('2026-11-07')
    expect(gibsTime('gibs-modis-aqua', Date.parse('2026-11-07T23:59:59Z'), now)).toBe('2026-11-07')
  })

  it('refuses collections GIBS does not serve', () => {
    expect(() => geoImageUrl('sentinel-2-l2a', WATERLOO, 0, { halfSizeKm: 3, px: 64 })).toThrow(TypeError)
  })

  it('formats UTC dates', () => {
    expect(utcDate(Date.parse('2026-01-02T23:59:59Z'))).toBe('2026-01-02')
    expect(utcDate(Date.parse('2026-01-03T00:00:00Z'))).toBe('2026-01-03')
  })
})

describe('weather candidates', () => {
  it('keeps daytime, in-swath passes of GIBS-served imagers, one per layer per UTC day', () => {
    const passes = [
      pass({ id: 'a', norad: 43013, groundDistanceKm: 400 }),
      pass({ id: 'b', norad: 43013, groundDistanceKm: 90, tClosest: Date.parse('2026-11-07T19:58:00Z') }), // same day, nearer nadir
      pass({ id: 'c', norad: 43013, tClosest: Date.parse('2026-11-06T18:40:00Z') }),
      pass({ id: 'night', norad: 54234, sunElevationDeg: -10 }),
      pass({ id: 'dawn', norad: 25994, sunElevationDeg: 4.9 }),
      pass({ id: 'edge', norad: 27424, inSwath: false }),
      pass({ id: 's2', norad: 60989 }),
      pass({ id: 'terra', norad: 25994, sunElevationDeg: 30, tClosest: Date.parse('2026-11-07T16:05:00Z') }),
    ]
    const caps = weatherCandidates(WATERLOO, passes)
    expect(caps.map((c) => c.itemId)).toEqual([
      'VIIRS_NOAA20_CorrectedReflectance_TrueColor@2026-11-07',
      'MODIS_Terra_CorrectedReflectance_TrueColor@2026-11-07',
      'VIIRS_NOAA20_CorrectedReflectance_TrueColor@2026-11-06',
    ])
    const n20 = caps[0]
    expect(n20.provider).toBe('gibs')
    expect(n20.collection).toBe('gibs-viirs-noaa20')
    expect(n20.platform).toBe('noaa-20')
    expect(n20.norad).toBe(43013)
    expect(n20.datetime).toBe(Date.parse('2026-11-07T19:58:00Z')) // the nearer-nadir pass
    expect(n20.gsdM).toBe(375)
    expect(caps[1].gsdM).toBe(250)
    const crop = new URL(n20.cropUrl({ halfSizeKm: 100, px: 640 })).searchParams
    expect(crop.get('TIME')).toBe('2026-11-07')
    expect(crop.get('WIDTH')).toBe('640')
    expect(n20.sourceUrl).toContain('worldview.earthdata.nasa.gov')
  })
})

describe('no-data measurement', () => {
  const px = (...rgba: number[][]) => new Uint8ClampedArray(rgba.flat())
  it('treats pure black and transparent pixels as no data', () => {
    expect(measureNoData(px([0, 0, 0, 255], [0, 0, 0, 255])).noDataFraction).toBe(1)
    expect(measureNoData(px([200, 200, 200, 0])).noDataFraction).toBe(1)
    expect(measureNoData(px([5, 6, 4, 255], [120, 130, 140, 255])).noDataFraction).toBe(0.5)
  })
  it('keeps dark-but-real pixels (night GeoColor, Himawari ocean) as data', () => {
    const r = measureNoData(px([12, 14, 20, 255], [9, 9, 9, 255]))
    expect(r.noDataFraction).toBe(0)
    expect(r.meanLuma).toBeGreaterThan(8)
  })
  it('handles empty input', () => {
    expect(measureNoData(new Uint8ClampedArray(0)).noDataFraction).toBe(1)
  })
})
