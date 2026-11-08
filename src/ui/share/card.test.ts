/**
 * Round 2 share card behaviour:
 *  - R2SH1 the plate is cut from the pass view's decoded crop (cardSource maps the card's square into it)
 *  - R2SH3 one rule for clouded words, in the card, the server description and the post
 *  - R2SH5 the summary counts satellites with detailed pictures, as the results headline does
 */
import { describe, expect, it } from 'vitest'
import type { Capture, Pass, Report } from '@/types'
import { buildCardSpec, cardCrop, cloudWords, type CardInput } from '../../../api/_lib/cardSpec'
import { waterlooReport } from '../results/__fixtures__/waterloo'
import { isDetailed } from '../results/lib/captures'
import { headline, type Headline } from '../results/lib/copy'
import type { SatMeta } from '../results/lib/meta'
import { cardSource, summaryFacts } from './card'
import { postText, roundedPlace, summaryPostText } from './links'

// The server module reads process.env and tz-lookup: imported by a runtime specifier (as spec.test.ts).
interface ServerShare {
  shareFromRpc: (v: unknown) => { capture?: unknown } | null
  description: (s: unknown) => string
  summaryTitle: (s: { satellites: number; placeLabel: string }) => string
}
const server = () => import('../../../api/_lib/share.ts' as string) as Promise<ServerShare>

const EXACT = { lat: 43.4723, lon: -80.5449 }
const ROUNDED = roundedPlace(EXACT.lat, EXACT.lon)

/** A capture whose crop URL is built around the exact point, as the engine builds them. */
async function captureOf(collection: string): Promise<Capture> {
  const report = await waterlooReport({ withTracks: false })
  const c = report.captures.find((x) => x.collection === collection)
  if (!c) throw new Error(`no ${collection} capture in the fixture`)
  return c
}

describe('cardSource: the card cut from the pass view’s crop (R2SH1)', () => {
  it('maps the Sentinel-2 card square into the 1024 px, ±5 km pass-view crop', async () => {
    const s2 = await captureOf('sentinel-2-l2a')
    const crop = cardCrop(s2)
    expect(crop.halfSizeKm).toBeCloseTo(3.15)
    const src = cardSource(s2, EXACT, ROUNDED, crop)!
    expect(src).toBeTruthy()
    expect(src.px).toBe(1024)
    expect(src.url).toMatch(/\/item\/bbox\/[^/]+\/1024x1024\.jpg\?collection=sentinel-2-l2a&item=S2/)
    expect(Math.abs(src.sw - 645)).toBeLessThanOrEqual(2)
    expect(Math.abs(src.sh - 645)).toBeLessThanOrEqual(2)
    expect(Math.abs(src.sx - 230)).toBeLessThanOrEqual(2)
    expect(Math.abs(src.sy - 216)).toBeLessThanOrEqual(2)
  })

  it('fits Landsat (±6.3 in ±7.5 km) and VIIRS (±118 in ±120 km) crops too', async () => {
    const l9 = await captureOf('landsat-c2-l2')
    const lc = cardCrop(l9)
    expect(lc.halfSizeKm).toBeCloseTo(6.3)
    const ls = cardSource(l9, EXACT, ROUNDED, lc)
    expect(ls).toBeTruthy()
    expect(ls!.sx).toBeGreaterThan(0)
    expect(ls!.sx + ls!.sw).toBeLessThan(1024)

    const report = await waterlooReport({ withTracks: false })
    const viirs = report.captures.find((c) => c.collection.startsWith('gibs-viirs'))!
    expect(viirs).toBeTruthy()
    const vc = cardCrop(viirs)
    expect(vc.halfSizeKm).toBeCloseTo(118.125)
    const vs = cardSource(viirs, EXACT, ROUNDED, vc)
    expect(vs).toBeTruthy()
    expect(vs!.url).toMatch(/^https:\/\/gibs\.earthdata\.nasa\.gov\/wms\/epsg4326\/.*BBOX=/)
    expect(vs!.sy).toBeGreaterThanOrEqual(0)
    expect(vs!.sy + vs!.sh).toBeLessThanOrEqual(1024)
  })

  it('refuses a rect that leaves the source, or a capture with no linear crop', async () => {
    const s2 = await captureOf('sentinel-2-l2a')
    const crop = cardCrop(s2)
    // The rounded point 3 km east of the searched one: the 3.15 km half-square pokes out of the ±5 km crop.
    expect(cardSource(s2, EXACT, { lat: EXACT.lat, lon: EXACT.lon + 0.04 }, crop)).toBeUndefined()
    expect(cardSource(s2, EXACT, ROUNDED, { halfSizeKm: 6 })).toBeUndefined()
    // An Earth Search thumbnail (not a bbox crop) or a crop URL that throws.
    expect(cardSource({ ...s2, cropUrl: () => 'https://earth-search.example/thumb.jpg' }, EXACT, ROUNDED, crop)).toBeUndefined()
    expect(
      cardSource(
        {
          ...s2,
          cropUrl: () => {
            throw new Error('no crop')
          },
        },
        EXACT,
        ROUNDED,
        crop,
      ),
    ).toBeUndefined()
  })
})

describe('clouded words match the picture (R2SH3)', () => {
  const ROW = {
    id: 'ab3d5f7h',
    placeLabel: 'Waterloo',
    lat: 43.47,
    lon: -80.54,
    norad: 42063,
    satName: 'Sentinel-2B',
    verdict: 'imaged',
    tClosest: 1793377877966,
    pass: { norad: 42063, tClosest: 1793377877966, altitudeKm: 795, offNadirDeg: 8.9, verdict: 'imaged' },
  }
  const input = (cloudCoverPct: number, spot?: 'clear' | 'cloud'): CardInput => ({
    verdict: 'imaged',
    satName: 'Sentinel-2B',
    placeLabel: 'Waterloo',
    lat: 43.47,
    lon: -80.54,
    tClosest: ROW.tClosest,
    timeZone: 'America/Toronto',
    pass: { altitudeKm: 795, offNadirDeg: 8.9 },
    capture: { collection: 'sentinel-2-l2a', itemId: 'S2B_MSIL2A_20261030T162419_R040_T17TNJ_20261030T200303', cloudCoverPct, spot },
    host: 'overflight.app',
  })
  const post = (pct: number, spot?: string) =>
    postText({ verdict: 'imaged', satName: 'Sentinel-2B', placeLabel: 'Waterloo', altitudeKm: 795, localDay: 'Fri 30 Oct', localTime: '12:24', resolution: '10 m', cloud: { pct, spot } })

  const CASES = [
    { pct: 93, spot: undefined, sub: 'Clouded over. It saw only cloud.', chip: 'Clouded over · 93%', desc: 'It saw only cloud (93%).', post: 'It saw only cloud.' },
    { pct: 81, spot: undefined, sub: 'Mostly cloud: 81% of the scene.', chip: 'Mostly cloud · 81%', desc: 'It saw mostly cloud (81%).', post: 'It saw mostly cloud (81%).' },
    { pct: 64, spot: 'cloud' as const, sub: 'Cloud over the spot itself.', chip: 'Cloud over the spot', desc: 'Cloud covered the spot.', post: 'Cloud covered the spot.' },
  ]

  it('says the same thing in the card, the server description and the post', async () => {
    const { shareFromRpc, description } = await server()
    for (const c of CASES) {
      const spec = buildCardSpec(input(c.pct, c.spot))
      expect(spec.sub).toBe(c.sub)
      expect(spec.plate.kind === 'image' && spec.plate.clouded?.segs[0].text).toBe(c.chip)
      const share = shareFromRpc({ ...ROW, capture: { collection: 'sentinel-2-l2a', itemId: 'S2B_MSIL2A_20261030T162419_R040_T17TNJ_20261030T200303', cloudCoverPct: c.pct, spot: c.spot } })
      expect(description(share)).toContain(` ${c.desc} What photographed you this week?`)
      expect(post(c.pct, c.spot)).toContain(`from 795 km up on Fri 30 Oct at 12:24 local. ${c.post}\n\n`)
      expect(cloudWords(c.pct, c.spot)).toEqual({ sub: c.sub, chip: c.chip, post: c.post, desc: c.desc })
    }
  })

  it('leaves a clear picture alone', async () => {
    const { shareFromRpc, description } = await server()
    const spec = buildCardSpec(input(30, 'clear'))
    expect(spec.sub).toBeUndefined()
    expect(spec.plate.kind === 'image' && spec.plate.clouded).toBeUndefined()
    const share = shareFromRpc({ ...ROW, capture: { collection: 'sentinel-2-l2a', itemId: 'S2B_MSIL2A_20261030T162419_R040_T17TNJ_20261030T200303', cloudCoverPct: 30, spot: 'clear' } })
    expect(description(share)).toContain('Cloud cover: 30%.')
    expect(post(30, 'clear')).toContain('10 m per pixel; this is the actual image.')
    expect(cloudWords(30, 'clear')).toBeUndefined()
  })

  it('never says "only cloud" below 90 %', async () => {
    const { shareFromRpc, description } = await server()
    for (const pct of [0, 30, 64, 70, 81, 89.4]) {
      for (const spot of ['clear', 'cloud', undefined] as const) {
        const words = [cloudWords(pct, spot), buildCardSpec(input(pct, spot)).sub, post(pct, spot)]
        const share = shareFromRpc({ ...ROW, capture: { collection: 'sentinel-2-l2a', itemId: 'S2B_MSIL2A_20261030T162419_R040_T17TNJ_20261030T200303', cloudCoverPct: pct, spot } })
        expect(JSON.stringify([...words, description(share)])).not.toMatch(/only cloud/i)
      }
    }
  })
})

describe('summary counts detailed photographs (R2SH5)', () => {
  const META: Record<number, SatMeta> = {}
  const meta = (n: number): SatMeta => META[n] ?? { norad: n, name: `NORAD ${n}`, category: 'other' }

  /** Distinct satellites with a detailed (Sentinel-2 / Landsat) picture, counted from scratch. */
  function detailedSats(report: Report): number {
    const byId = new Map(report.captures.map((c) => [c.id, c]))
    const set = new Set<number>()
    for (const p of report.passes) {
      const c = p.verdict === 'imaged' && p.captureId ? byId.get(p.captureId) : undefined
      if (c && isDetailed(c)) set.add(p.norad)
    }
    return set.size
  }

  it('counts what the results headline counts, and words it the same way', async () => {
    const { summaryTitle } = await server()
    const report = await waterlooReport({ withTracks: false })
    const f = summaryFacts(report, 'Waterloo', (n) => meta(n).name)
    // The results headline's own count once it carries one (R2R11), else the same rule counted here.
    const h = headline(report, meta) as Headline & { detailedSats?: number }
    expect(f.satellites).toBe(h.detailedSats ?? detailedSats(report))
    expect(f.satellites).toBeGreaterThan(0)
    // Weather mosaics photographed it too, but don't count.
    const imagedSats = new Set(report.passes.filter((p) => p.verdict === 'imaged').map((p) => p.norad)).size
    expect(f.satellites).toBeLessThan(imagedSats)
    const n = f.satellites
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: n, passes: 1800, best: { satName: 'Landsat 9', altitudeKm: 708 } })).toMatch(
      new RegExp(`^${n} satellites photographed Waterloo in detail this week\\. The clearest one, Landsat 9, from 708 km up\\.`),
    )
    expect(summaryTitle({ satellites: n, placeLabel: 'Waterloo' })).toBe(`${n} satellites photographed Waterloo in detail this week`)
  })

  it('gives a mosaics-only week n = 0 and the plain fallback', async () => {
    const { summaryTitle } = await server()
    const report = await waterlooReport({ withTracks: false })
    const mosaics = new Set(report.captures.filter((c) => !isDetailed(c)).map((c) => c.id))
    const only: Report = {
      ...report,
      captures: report.captures.filter((c) => mosaics.has(c.id)),
      passes: report.passes.filter((p: Pass) => p.verdict !== 'imaged' || (p.captureId && mosaics.has(p.captureId))),
    }
    expect(only.passes.some((p) => p.verdict === 'imaged')).toBe(true)
    const f = summaryFacts(only, 'Waterloo', (n) => meta(n).name)
    expect(f.satellites).toBe(0)
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: 0, passes: 1800 })).toBe(
      '1,800 satellite passes crossed Waterloo this week. None caught a clear picture.\n\nWhat passed over you this week?',
    )
    expect(summaryTitle({ satellites: 0, placeLabel: 'Waterloo' })).toBe('What passed over Waterloo this week')
  })
})
