import { describe, expect, it } from 'vitest'
import type { Capture, Pass } from '@/types'
import { captureFor, cropSpec, displayUrl, isDailyMosaic, productLabel, scaleBarKm, slug } from './captures'
import { compassAbbr, compassWord, geoSentence, headline, passSentences, plain, shareHeadline } from './copy'
import { groupPasses, visibleCount } from './groups'
import type { SatMeta } from './meta'
import { frontLine, motionVector, revealProgress, scannedPolygon, sweepRange } from './pushbroom'
import { replayWindow, windowFraction } from './replay'
import { fmtDuration, fmtLocalDay, fmtLocalStamp, fmtLocalTime, fmtRelative, fmtTMinus, utcOffsetMin, zoneAbbr } from './time'
import { dayBoundaries, daylight, hitTest, hourMarks, indexLanes, nearestIndex, stepPass, sunSamples } from './timeline'

const TZ = 'America/Toronto'
const WATERLOO = { lat: 43.4723, lon: -80.5449 }

let seq = 0
function pass(over: Partial<Pass> = {}): Pass {
  const t = over.tClosest ?? Date.parse('2026-11-01T16:21:13Z')
  return {
    id: `x-${seq++}`,
    norad: 60989,
    tClosest: t,
    tStart: t - 19_000,
    tEnd: t + 19_000,
    groundDistanceKm: 61.2,
    offNadirDeg: 5.26,
    elevationDeg: 84,
    azimuthDeg: 268,
    altitudeKm: 786.4,
    groundSpeedKmS: 6.823,
    headingDeg: 194.6,
    node: 'descending',
    sunElevationDeg: 28.4,
    inSwath: true,
    inFieldOfRegard: true,
    verdict: 'imaged',
    track: [],
    ...over,
  }
}

const META: Record<number, SatMeta> = {
  60989: { norad: 60989, name: 'Sentinel-2C', category: 'open-optical', operator: 'ESA / Copernicus', profile: { operator: 'ESA', category: 'open-optical', swathKm: 290, blurb: '' } },
  43013: { norad: 43013, name: 'NOAA-20', category: 'weather-leo', operator: 'NOAA', profile: { operator: 'NOAA', category: 'weather-leo', swathKm: 3000, blurb: '', gibs: { collection: 'gibs-viirs-noaa20', layer: 'L', kind: 'daily' } } },
  59625: { norad: 59625, name: 'Legion 1', category: 'commercial-optical', operator: 'Maxar' },
  40697: { norad: 40697, name: 'Sentinel-1A', category: 'radar' },
  25544: { norad: 25544, name: 'ISS', category: 'crewed' },
}
const meta = (n: number): SatMeta => META[n] ?? { norad: n, name: `NORAD ${n}`, category: 'other' }

const s2: Capture = {
  id: 'S2C_X',
  provider: 'planetary-computer',
  collection: 'sentinel-2-l2a',
  itemId: 'S2C_X',
  platform: 'sentinel-2c',
  datetime: Date.parse('2026-11-01T16:14:21Z'),
  cloudCoverPct: 25.46,
  gsdM: 10,
  cropUrl: ({ halfSizeKm, px }) =>
    `https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/1,2,3,4/${px}x${px}.png?collection=sentinel-2-l2a&item=S2C_X&h=${halfSizeKm}`,
}
const viirs: Capture = {
  id: 'VIIRS@2026-11-01',
  provider: 'gibs',
  collection: 'gibs-viirs-noaa20',
  itemId: 'VIIRS@2026-11-01',
  platform: 'noaa-20',
  datetime: 0,
  gsdM: 375,
  cropUrl: () => 'https://gibs.earthdata.nasa.gov/wms?x=1',
}

describe('time', () => {
  it('formats in the place time zone across the DST change', () => {
    // 1 Nov 2026: Ontario leaves daylight time at 02:00 local.
    const before = Date.parse('2026-11-01T05:30:00Z')
    const after = Date.parse('2026-11-01T16:21:13Z')
    expect(zoneAbbr(before, TZ)).toBe('EDT')
    expect(zoneAbbr(after, TZ)).toBe('EST')
    expect(fmtLocalTime(after, TZ, true)).toBe('11:21:13')
    expect(fmtLocalDay(after, TZ)).toBe('Sun 1 Nov')
    expect(fmtLocalStamp(after, TZ)).toBe('Sun 1 Nov · 11:21 EST')
    expect(utcOffsetMin(after, TZ)).toBe(-300)
    expect(utcOffsetMin(before, TZ)).toBe(-240)
  })
  it('falls back to UTC+N labels where there is no abbreviation', () => {
    expect(zoneAbbr(Date.parse('2026-11-01T00:00:00Z'), 'Asia/Kolkata')).toMatch(/^(IST|UTC\+5:30)$/)
    expect(zoneAbbr(0, 'UTC')).toBe('UTC')
  })
  it('relative times read like an instrument', () => {
    const now = Date.parse('2026-11-08T12:00:00Z')
    expect(fmtRelative(now - 20_000, now)).toBe('just now')
    expect(fmtRelative(now - 12 * 60_000, now)).toBe('12 min ago')
    expect(fmtRelative(now - 30 * 3_600_000, now)).toBe('30 h ago')
    expect(fmtRelative(now - 3 * 86_400_000, now)).toBe('3 days ago')
    expect(fmtRelative(now + 3 * 3_600_000, now)).toBe('in 3 h')
  })
  it('T-minus and durations', () => {
    expect(fmtTMinus(1000, 43_000)).toBe('T−00:42')
    expect(fmtTMinus(66_000, 1_000)).toBe('T+01:05')
    expect(fmtTMinus(3_700_000, 0)).toBe('T+1:01:40')
    expect(fmtDuration(38_400)).toBe('38 s')
    expect(fmtDuration(252_000)).toBe('4 min 12 s')
  })
})

describe('copy', () => {
  it('compass words and abbreviations', () => {
    expect(compassWord(194.6)).toBe('south')
    expect(compassWord(345)).toBe('north')
    expect(compassWord(268)).toBe('west')
    expect(compassAbbr(194.6)).toBe('SSW')
    expect(compassAbbr(-10)).toBe('N')
  })

  it('headline counts distinct satellites and splits detailed images from mosaics', () => {
    const report = {
      captures: [s2, viirs],
      notes: [],
      passes: [
        pass({ norad: 60989, captureId: 'S2C_X' }),
        pass({ norad: 43013, captureId: 'VIIRS@2026-11-01' }),
        pass({ norad: 43013, verdict: 'likely', captureId: undefined }), // same sat: not "more"
        pass({ norad: 59625, verdict: 'could' }),
        pass({ norad: 59625, verdict: 'could' }),
        pass({ norad: 25544, verdict: 'overhead' }),
      ],
    }
    const h = headline(report, meta)
    expect(h).toMatchObject({ photographed: 2, more: 2, images: 2, detailed: 1, mosaics: 1 })
    expect(h.zeroReason).toBeUndefined()
  })

  it('states a plain reason when nothing photographed the place', () => {
    const likelyS2 = { captures: [], notes: [], passes: [pass({ verdict: 'likely' }), pass({ verdict: 'likely' })] }
    expect(headline(likelyS2, meta).zeroReason).toBe('Sentinel-2 or Landsat crossed it 2 times in daylight, but no scene has been published yet')
    const outage = { captures: [], notes: ['The Sentinel-2 and Landsat archives could not be reached; passes are shown from orbital geometry only.'], passes: [] }
    expect(headline(outage, meta).zeroReason).toBe('the image archives did not answer in time')
    const dark = { captures: [], notes: [], passes: [pass({ norad: 25544, verdict: 'overhead', sunElevationDeg: -20 })] }
    expect(headline(dark, meta).zeroReason).toBe('the sun barely rose there')
  })

  it('writes the pass sentence from real numbers (tClosest, never the scene time)', () => {
    const p = pass({ captureId: 'S2C_X' })
    const text = plain(passSentences({ pass: p, meta: meta(60989), capture: s2, timeZone: TZ, placeLabel: 'Waterloo' }))
    expect(text).toBe(
      'Sentinel-2C crossed 786 km up, 61 km to the west at 11:21:13 EST, moving south at 6.82 km/s. It was looking 5.3° off straight down. Cloud cover across the scene: 25%.',
    )
    expect(text).not.toContain('11:14') // the archive's datatake-start time
  })

  it('says "overhead" and "straight down" when it was', () => {
    const p = pass({ groundDistanceKm: 3, offNadirDeg: 0.2 })
    const text = plain(passSentences({ pass: p, meta: meta(60989), capture: s2, timeZone: TZ, placeLabel: 'Waterloo' }))
    expect(text).toContain('786 km overhead')
    expect(text).toContain('It was looking straight down.')
  })

  it('labels weather mosaics honestly and hedges "could" passes', () => {
    const w = plain(passSentences({ pass: pass({ norad: 43013 }), meta: meta(43013), capture: viirs, timeZone: TZ, placeLabel: 'Waterloo' }))
    expect(w).toContain('VIIRS imager')
    expect(w).toContain('daily true-colour mosaic at 375 m per pixel')
    const c = plain(passSentences({ pass: pass({ norad: 59625, verdict: 'could', offNadirDeg: 22.4 }), meta: meta(59625), timeZone: TZ, placeLabel: 'Waterloo' }))
    expect(c).toContain('Legion 1 passed within view at 11:21 EST')
    expect(c).toContain('We can’t know whether it did.')
    const r = plain(passSentences({ pass: pass({ norad: 40697, verdict: 'could' }), meta: meta(40697), timeZone: TZ, placeLabel: 'Waterloo' }))
    expect(r).toContain('Radar sees through cloud and darkness')
    const iss = plain(passSentences({ pass: pass({ norad: 25544, verdict: 'overhead', elevationDeg: 58, sunElevationDeg: -14 }), meta: meta(25544), timeZone: TZ, placeLabel: 'Waterloo' }))
    expect(iss).toContain('ISS passed 786 km up at 11:21 EST, 58° above your horizon')
    expect(iss).toContain('It was dark where you are.')
  })

  it('geostationary sentence', () => {
    const g = { norad: 1, name: 'GOES-19', operator: 'NOAA', subLon: -75.2, elevationDeg: 39.6, cadenceMin: 10, imagesInWindow: 1008 }
    expect(plain(geoSentence(g, 7))).toBe('GOES-19 has photographed this spot every 10 minutes, all week: 1,008 times.')
  })

  it('share headline per verdict', () => {
    expect(shareHeadline('imaged', 'Sentinel-2C', 'Waterloo')).toEqual({ lead: 'Sentinel-2C photographed', place: 'Waterloo' })
    expect(shareHeadline('could', 'Legion 1', 'Waterloo').lead).toBe('Legion 1 passed within view of')
  })
})

describe('captures', () => {
  it('finds the capture and sizes the crop per collection', () => {
    expect(captureFor({ captures: [s2, viirs] }, { captureId: 'S2C_X' })).toBe(s2)
    expect(captureFor({ captures: [s2] }, {})).toBeUndefined()
    expect(cropSpec('sentinel-2-l2a')).toEqual({ halfSizeKm: 5, px: 1024 })
    expect(cropSpec('landsat-c2-l2').halfSizeKm).toBe(7.5)
    expect(cropSpec('gibs-viirs-noaa20').halfSizeKm).toBe(120)
  })
  it('asks Planetary Computer for JPEG (≈7× smaller) and leaves other providers alone', () => {
    expect(displayUrl(s2, { halfSizeKm: 5, px: 1024 })).toMatch(/\/1024x1024\.jpg\?collection=/)
    expect(displayUrl(viirs, { halfSizeKm: 5, px: 1024 })).toBe('https://gibs.earthdata.nasa.gov/wms?x=1')
  })
  it('labels', () => {
    expect(isDailyMosaic(viirs)).toBe(true)
    expect(isDailyMosaic(s2)).toBe(false)
    expect(productLabel(viirs)).toBe('Daily mosaic, 375 m')
    expect(productLabel(s2)).toBe('Sentinel-2 L2A, 10 m')
    expect(scaleBarKm(10)).toBe(2)
    expect(scaleBarKm(240)).toBe(20)
    expect(slug('Sentinel-2C — Montréal, QC')).toBe('sentinel-2c-montreal-qc')
  })
})

describe('groups', () => {
  it('detailed images are rows; everything else is summarised per satellite', () => {
    const report = {
      captures: [s2, viirs],
      passes: [
        pass({ norad: 60989, captureId: 'S2C_X', tClosest: 3 }),
        pass({ norad: 43013, captureId: 'VIIRS@2026-11-01', tClosest: 2 }),
        pass({ norad: 59625, verdict: 'could', tClosest: 10, offNadirDeg: 30 }),
        pass({ norad: 59625, verdict: 'could', tClosest: 20, offNadirDeg: 12 }),
        pass({ norad: 40697, verdict: 'could', tClosest: 30 }),
      ],
    }
    const groups = groupPasses(report, meta)
    expect(groups.map((g) => g.verdict)).toEqual(['imaged', 'could'])
    const [imaged, could] = groups
    expect(imaged.items.map((i) => i.kind)).toEqual(['pass', 'sat'])
    expect(could).toMatchObject({ passCount: 3, satCount: 2 })
    const legion = could.items[0]
    expect(legion.kind).toBe('sat')
    if (legion.kind === 'sat') {
      expect(legion.passes.map((p) => p.tClosest)).toEqual([20, 10]) // newest first
      expect(legion.closest.offNadirDeg).toBe(12)
    }
  })
  it('caps and pages', () => {
    expect(visibleCount(236, 'could', 0)).toBe(6)
    expect(visibleCount(236, 'could', 1)).toBe(46)
    expect(visibleCount(5, 'imaged', 0)).toBe(5)
  })
})

describe('timeline', () => {
  const t0 = Date.parse('2026-10-27T04:00:00Z')
  const t1 = Date.parse('2026-11-03T04:00:00Z')
  it('samples the sun every 10 min and shades twilight smoothly', () => {
    const s = sunSamples(WATERLOO.lat, WATERLOO.lon, t0, t1)
    expect(s.length).toBe(7 * 144 + 1)
    expect(Math.max(...s)).toBeGreaterThan(25)
    expect(Math.min(...s)).toBeLessThan(-50)
    expect(daylight(-10)).toBe(0)
    expect(daylight(10)).toBe(1)
    expect(daylight(0)).toBeCloseTo(0.5)
  })
  it('finds local midnights, DST included', () => {
    const days = dayBoundaries(t0, t1, TZ)
    // t0 is itself local midnight (27 Oct 00:00 EDT); 3 Nov 00:00 EST is 05:00Z, just past t1.
    expect(days.length).toBe(6)
    expect(new Date(days[0].t).toISOString()).toBe('2026-10-28T04:00:00.000Z') // EDT midnight
    expect(new Date(days[4].t).toISOString()).toBe('2026-11-01T04:00:00.000Z') // the DST night
    expect(new Date(days[5].t).toISOString()).toBe('2026-11-02T05:00:00.000Z') // EST midnight
    expect(days[4].label).toBe('Sun 1 Nov')
  })
  it('handles half-hour zones', () => {
    const days = dayBoundaries(t0, t1, 'Asia/Kolkata')
    expect(new Date(days[0].t).toISOString()).toBe('2026-10-27T18:30:00.000Z')
  })
  it('hour marks skip midnight', () => {
    const h = hourMarks(t0, t0 + 86_400_000, TZ, 6)
    expect(h.map((x) => x.hour)).toEqual([6, 12, 18])
  })
  it('hit-tests and steps within a verdict', () => {
    const ps = [pass({ tClosest: 100, verdict: 'imaged' }), pass({ tClosest: 300, verdict: 'imaged' }), pass({ tClosest: 200, verdict: 'could' })]
    const lanes = indexLanes(ps)
    expect(nearestIndex(lanes.imaged.times, 210)).toBe(1)
    expect(nearestIndex([], 5)).toBe(-1)
    expect(hitTest(lanes, 205, 10)?.verdict).toBe('could')
    expect(hitTest(lanes, 205, 10, 'imaged')).toMatchObject({ verdict: 'could' }) // nothing imaged within 10
    expect(hitTest(lanes, 290, 20, 'could')?.tClosest).toBe(300)
    expect(stepPass(lanes, undefined, 1)?.tClosest).toBe(100)
    expect(stepPass(lanes, undefined, -1)?.tClosest).toBe(300)
    expect(stepPass(lanes, lanes.imaged.passes[0], 1)?.tClosest).toBe(300)
    expect(stepPass(lanes, lanes.imaged.passes[1], 1)?.tClosest).toBe(300) // clamps at the end
  })
})

describe('replay', () => {
  it('pads short in-swath windows to ±90 s', () => {
    const p = pass()
    const w = replayWindow(p)
    expect(w[1] - w[0]).toBe(180_000)
    expect(windowFraction(p.tClosest, w)).toBeCloseTo(0.5)
    const long = { tStart: 0, tEnd: 600_000, tClosest: 300_000 }
    expect(replayWindow(long)).toEqual([0, 600_000])
  })
})

describe('pushbroom', () => {
  it('moves along the heading in screen space', () => {
    const south = motionVector(180)
    expect(south.x).toBeCloseTo(0)
    expect(south.y).toBeCloseTo(1)
    const east = motionVector(90)
    expect(east.x).toBeCloseTo(1)
    const [a, b] = sweepRange(100, 100, south)
    expect(a).toBeCloseTo(0)
    expect(b).toBeCloseTo(100)
    const ne = sweepRange(100, 100, motionVector(45))
    expect(ne[0]).toBeCloseTo(-70.71, 1)
    expect(ne[1]).toBeCloseTo(70.71, 1)
  })
  it('scanned polygon covers what is behind the front', () => {
    const d = motionVector(180)
    const poly = scannedPolygon(100, 100, d, 40)
    // every vertex is behind or on the front (p·d ≤ s)
    for (const v of poly) expect(v.x * d.x + v.y * d.y).toBeLessThanOrEqual(40 + 1e-9)
    const [a, b] = frontLine(100, 100, d, 40)
    expect(a.y).toBeCloseTo(40)
    expect(b.y).toBeCloseTo(40)
    expect(revealProgress(800)).toBe(0.5)
    expect(revealProgress(5000)).toBe(1)
  })
})

describe('copy: fixed-swath commercial', () => {
  it('says the place was inside the swath and that the archive is private', () => {
    const dove: SatMeta = { norad: 1, name: 'Flock 4Q-13', category: 'commercial-optical', profile: { operator: 'Planet', category: 'commercial-optical', swathKm: 32, blurb: '' } }
    const text = plain(passSentences({ pass: pass({ norad: 1, verdict: 'could', inSwath: true }), meta: dove, timeZone: TZ, placeLabel: 'Waterloo' }))
    expect(text).toContain('Waterloo was inside its 32 km swath.')
    expect(text).toContain('we can’t know whether it did')
  })
})

// ── reviewer additions ──────────────────────────────────────────────────────────────────────

describe('timeline: day/night is the real sun at the place, in its own time zone', () => {
  /** Local clock time of the first sample in [a, b) where the sun crosses 0° in the given direction. */
  const crossing = (a: number, b: number, rising: boolean) => {
    const s = sunSamples(WATERLOO.lat, WATERLOO.lon, a, b)
    for (let i = 1; i < s.length; i++) if (rising ? s[i - 1] < 0 && s[i] >= 0 : s[i - 1] >= 0 && s[i] < 0) return fmtLocalTime(a + i * 600_000, TZ)
    return undefined
  }
  it('Waterloo, Sun 1 Nov 2026 (first day of EST): sunrise ≈ 06:59, sunset ≈ 17:13 local', () => {
    const day = Date.parse('2026-11-01T05:00:00Z') // 00:00 EST
    const rise = crossing(day, day + 86_400_000, true)!
    const set = crossing(day, day + 86_400_000, false)!
    expect(rise >= '06:50' && rise <= '07:10').toBe(true)
    expect(set >= '17:05' && set <= '17:25').toBe(true)
  })
  it('Waterloo, Tue 27 Oct 2026 (EDT): sunrise ≈ 07:53, sunset ≈ 18:20 local', () => {
    const day = Date.parse('2026-10-27T04:00:00Z') // 00:00 EDT
    const rise = crossing(day, day + 86_400_000, true)!
    const set = crossing(day, day + 86_400_000, false)!
    expect(rise >= '07:45' && rise <= '08:05').toBe(true)
    expect(set >= '18:10' && set <= '18:30').toBe(true)
  })
  it('shades local noon fully and local midnight not at all', () => {
    const noon = Date.parse('2026-11-01T17:00:00Z') // 12:00 EST
    const midnight = Date.parse('2026-11-02T05:00:00Z') // 00:00 EST
    const s = sunSamples(WATERLOO.lat, WATERLOO.lon, noon, midnight)
    expect(daylight(s[0])).toBe(1)
    expect(daylight(s[s.length - 1])).toBe(0)
  })
})

describe('pushbroom: a descending Sentinel-2 pass (heading 194.6°, SSW)', () => {
  const d = motionVector(194.6)
  const W = 400
  const H = 400
  it('starts at the top-right (NNE) corner and finishes at the bottom-left', () => {
    const corners = { tl: 0, tr: W * d.x, bl: H * d.y, br: W * d.x + H * d.y }
    const [a, b] = sweepRange(W, H, d)
    expect(a).toBeCloseTo(corners.tr) // the first line the satellite records is the one furthest north-north-east
    expect(b).toBeCloseTo(corners.bl)
  })
  it('sweeps top to bottom with the front tilted ~14.6° (right side ahead)', () => {
    const [a, b] = sweepRange(W, H, d)
    const front = a + (b - a) * 0.5
    // y of the front at the left and right edges: p·d = s → y = (s − x·dx) / dy
    const yAt = (x: number) => (front - x * d.x) / d.y
    expect(yAt(W)).toBeGreaterThan(yAt(0))
    expect((Math.atan2(yAt(W) - yAt(0), W) * 180) / Math.PI).toBeCloseTo(14.6, 1)
    expect(yAt(W / 2)).toBeCloseTo(H / 2) // the centre (the place) is reached exactly halfway
  })
})

describe('copy: degenerate geometry reads like a person wrote it', () => {
  it('a commercial pass straight over the place says "directly overhead", not "0 km to the west"', () => {
    const text = plain(passSentences({ pass: pass({ norad: 59625, verdict: 'could', inSwath: false, groundDistanceKm: 0.4, offNadirDeg: 0.04 }), meta: meta(59625), timeZone: TZ, placeLabel: 'Waterloo' }))
    expect(text).toContain('passed within view at 11:21 EST, directly overhead.')
    expect(text).toContain('Looking straight down, it could have photographed Waterloo.')
    expect(text).not.toMatch(/\b0 km|0\.0°/)
  })
  it('radar at nadir drops the 0.0° pointing clause', () => {
    const text = plain(passSentences({ pass: pass({ norad: 40697, verdict: 'could', inSwath: false, groundDistanceKm: 3, offNadirDeg: 0.3 }), meta: meta(40697), timeZone: TZ, placeLabel: 'Waterloo' }))
    expect(text).toContain('Radar sees through cloud and darkness. It could have mapped Waterloo.')
    expect(text).not.toContain('0.3°')
  })
  it('a crewed pass near the zenith gives no meaningless bearing', () => {
    const text = plain(passSentences({ pass: pass({ norad: 25544, verdict: 'overhead', elevationDeg: 89.2, azimuthDeg: 41, altitudeKm: 428 }), meta: meta(25544), timeZone: TZ, placeLabel: 'Waterloo' }))
    expect(text).toContain('89° above your horizon, almost straight up.')
    expect(text).not.toContain('northeast')
  })
  it('only an imaged pass is ever "photographed" (geostationary aside, per DESIGN §7)', () => {
    for (const verdict of ['likely', 'could', 'overhead'] as const) {
      for (const n of [60989, 43013, 59625, 40697, 25544]) {
        const text = plain(passSentences({ pass: pass({ norad: n, verdict, captureId: undefined }), meta: meta(n), timeZone: TZ, placeLabel: 'Waterloo' }))
        expect(text).not.toMatch(/photographed(?! Waterloo\. We can)/)
      }
      expect(shareHeadline(verdict, 'X', 'Waterloo').lead).not.toContain('photographed')
    }
  })
})
