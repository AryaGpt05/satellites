/**
 * Share card behaviour:
 *  - R2SH1 the plate is cut from the pass view's decoded crop (cardSource maps the card's square into it)
 *  - R2SH3 one rule for clouded words, in the card, the server description and the post
 *  - R3-13 the summary says what the results headline says: N satellites watched, K photos made public
 */
import { describe, expect, it } from 'vitest'
import type { Capture, Pass, Report } from '@/types'
import { buildCardSpec, buildSummarySpec, cardCrop, cloudWords, type CardInput } from '../../../api/_lib/cardSpec'
import { waterlooReport } from '../results/__fixtures__/waterloo'
import { isDetailed } from '../results/lib/captures'
import { ARCHIVE_DOWN_LINE, headline, photosLine, watchedPhrase } from '../results/lib/copy'
import type { SatMeta } from '../results/lib/meta'
import { cardSource, cropUrlFor, summaryCardSpec, summaryFacts } from './card'
import { postText, roundedPlace, summaryLink, summaryPostText } from './links'

// The server module reads process.env and tz-lookup: imported by a runtime specifier (as spec.test.ts).
interface ServerShare {
  shareFromRpc: (v: unknown) => { capture?: unknown } | null
  description: (s: unknown) => string
  summaryTitle: (s: { satellites: number; placeLabel: string }) => string
  summaryDescription: (s: unknown) => string
  summaryFromParams: (q: URLSearchParams) => unknown
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
  it('cuts the Sentinel-2 card from the pass view’s 1000 px photo at whole native pixels (the server’s very pixels)', async () => {
    const s2 = await captureOf('sentinel-2-l2a')
    const crop = cardCrop(s2)
    expect(crop.halfSizeKm).toBeCloseTo(3.15)
    const src = cardSource(s2, EXACT, ROUNDED, crop)!
    expect(src).toBeTruthy()
    expect(src.px).toBe(1000)
    expect(src.url).toMatch(/\/item\/bbox\/[^/]+\/1000x1000\.jpg\?collection=sentinel-2-l2a&item=S2[^&]+&coord_crs=EPSG:32617&dst_crs=EPSG:32617&/)
    // 630 of the photo's own 10 m pixels, at whole-pixel offsets: the card is the photo's pixels, not a resample.
    expect(src.sw).toBe(630)
    expect(src.sh).toBe(630)
    expect(Number.isInteger(src.sx) && Number.isInteger(src.sy)).toBe(true)
    // The rounded point is ≈ 397 m east and ≈ 255 m south of the searched one (grid north ≈ 0.3° off true north here).
    expect(Math.abs(src.sx - (185 + 40))).toBeLessThanOrEqual(2)
    expect(Math.abs(src.sy - (185 + 26))).toBeLessThanOrEqual(2)
    // And the server's card crop is exactly that square of the same grid (api/_lib/imagery.ts cropPlan builds this URL).
    const cardUrl = cropUrlFor(s2, crop, ROUNDED.lat, ROUNDED.lon)!
    expect(cardUrl).toMatch(/\/item\/bbox\/\d+,\d+,\d+,\d+\/630x630\.jpg\?collection=sentinel-2-l2a&item=S2[^&]+&coord_crs=EPSG:32617&dst_crs=EPSG:32617&/)
    expect(cardUrl).not.toMatch(/resampling/) // reproject=lanczos is a no-op for T17TNJ, on this grid
    const [px0, py1] = /\/bbox\/(\d+),\d+,\d+,(\d+)\//.exec(src.url)!.slice(1).map(Number)
    const [cx0, cy1] = /\/bbox\/(\d+),\d+,\d+,(\d+)\//.exec(cardUrl)!.slice(1).map(Number)
    expect([(cx0 - px0) / 10, (py1 - cy1) / 10]).toEqual([src.sx, src.sy])
  })

  it('fits Landsat (9.45 km at 15 m: 315 native px at 2×, in the 15 km photo) and VIIRS (±118 in ±120 km) crops too', async () => {
    const l9 = await captureOf('landsat-c2-l2')
    const lc = cardCrop(l9)
    expect(lc.halfSizeKm).toBeCloseTo(4.725)
    expect(lc.metresPerPx).toBe(15)
    const ls = cardSource(l9, EXACT, ROUNDED, lc)
    expect(ls).toBeTruthy()
    expect(ls!.px).toBe(1000)
    expect(ls!.sw).toBe(630)
    expect(ls!.sh).toBe(630)
    expect(ls!.sx % 2 === 0 && ls!.sy % 2 === 0).toBe(true) // whole 30 m pixels of the 2× photo
    expect(ls!.sx).toBeGreaterThan(0)
    expect(ls!.sx + ls!.sw).toBeLessThan(1000)

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
      expect(description(share)).toContain(` ${c.desc} What watched you this week?`)
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

describe('summary copy matches the results headline: N watched, K made public (R3-13)', () => {
  const META: Record<number, SatMeta> = {
    60989: { norad: 60989, name: 'Sentinel-2C', category: 'open-optical' },
    42063: { norad: 42063, name: 'Sentinel-2B', category: 'open-optical' },
  }
  const meta = (n: number): SatMeta => META[n] ?? { norad: n, name: `NORAD ${n}`, category: 'other' }

  it('counts N and K exactly as the results headline does, and words them the same way', async () => {
    const { summaryTitle, summaryDescription, summaryFromParams } = await server()
    const report = await waterlooReport({ withTracks: false })
    const f = summaryFacts(report, 'Waterloo', meta)
    const h = headline(report, meta)
    // N: distinct satellites with any pass (not only the ones with a detailed picture, as in round 2).
    expect(f.satellites).toBe(h.flewOver)
    expect(f.satellites).toBeGreaterThan(h.detailedSats)
    expect(f.satellites).toBe(new Set(report.passes.map((p) => p.norad)).size)
    // K: every real image of the week, weather mosaics included; it is the card's PHOTO readout too.
    expect(f.counts.imaged).toBe(h.images)
    expect(f.counts.imaged).toBe(report.passes.filter((p) => p.verdict === 'imaged').length)
    expect(h.mosaics).toBeGreaterThan(0)

    const lead = `${watchedPhrase(f.satellites)} Waterloo this week.`
    const photos = photosLine(f.counts.imaged)
    // The post, the card, the og:title and the og:description all say it.
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: f.satellites, photos: f.counts.imaged })).toBe(
      `${lead} ${photos}\n\nSomething watched you this week too.\nvia @armaangupt0`,
    )
    const spec = summaryCardSpec(report, 'Waterloo', meta, 'America/Toronto', 'www.watched.earth')
    expect(`${spec.lead} ${spec.place}${spec.tail}`).toBe(lead)
    expect(spec.sub).toBe(photos)
    expect(spec.readouts[0]).toEqual({ label: 'Photo', value: String(f.counts.imaged) })
    const link = summaryFromParams(new URL(summaryLink('https://www.watched.earth', f)).searchParams)
    expect(summaryTitle(link as { satellites: number; placeLabel: string })).toBe(lead)
    expect(summaryDescription(link)).toMatch(new RegExp(`^${photos.replace(/\./g, '\\.')} The closest look is from \\S.+\\. What watched you this week\\?$`))
    // Never the old words.
    expect(JSON.stringify([spec, summaryTitle(link as { satellites: number; placeLabel: string }), summaryDescription(link)])).not.toMatch(/photographed|in detail|best look/i)
  })

  it('uses the results’ singular, zero, partial and outage wording', async () => {
    const { summaryTitle, summaryDescription } = await server()
    const base = { placeLabel: 'Waterloo', lat: 43.47, lon: -80.54, host: '' }
    const counts = (imaged: number) => ({ imaged, likely: 3, could: 40, overhead: 9 })
    const one = buildSummarySpec({ ...base, satellites: 1, counts: counts(1) })
    expect(`${one.lead} ${one.place}${one.tail}`).toBe('1 satellite watched Waterloo this week.')
    expect(one.sub).toBe(photosLine(1))
    expect(one.sub).toBe('1 image was made public.')
    expect(buildSummarySpec({ ...base, satellites: 31, counts: counts(4), partial: true }).sub).toBe(photosLine(4, { partial: true }))
    // A zero reads "No images were made public." (the first sentence already says "this week").
    expect(buildSummarySpec({ ...base, satellites: 31, counts: counts(0) }).sub).toBe('No images were made public.')
    expect(photosLine(0)).toBe('No images were made public this week.')
    // Nothing flew over: the results' zero headline.
    const none = buildSummarySpec({ ...base, satellites: 0, counts: { imaged: 0, likely: 0, could: 0, overhead: 0 } })
    expect(`${none.lead} ${none.place}${none.tail}`).toBe('No satellite we track watched Waterloo this week.')
    expect(summaryTitle({ satellites: 0, placeLabel: 'Waterloo' })).toBe('No satellite we track watched Waterloo this week.')
    // The archives didn't answer: no count, the results' outage line (short on the card).
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: 31, photos: 0, archiveDown: true })).toContain(` ${ARCHIVE_DOWN_LINE}\n`)
    expect(summaryDescription({ placeLabel: 'Waterloo', counts: counts(0), archiveDown: true })).toBe(`${ARCHIVE_DOWN_LINE} What watched you this week?`)
    expect(buildSummarySpec({ ...base, satellites: 31, counts: counts(0), archiveDown: true }).sub).toBe('The image archives didn’t answer.')
  })

  it('flags an archive outage and a still-partial report in the facts', async () => {
    const report = await waterlooReport({ withTracks: false })
    expect(summaryFacts(report, 'Waterloo', meta)).toMatchObject({ archiveDown: undefined, partial: undefined })
    expect(summaryFacts({ ...report, partial: true }, 'Waterloo', meta)).toMatchObject({ partial: true })
    expect(summaryFacts({ ...report, archiveFailed: true, partial: true }, 'Waterloo', meta)).toMatchObject({ archiveDown: true, partial: undefined })
    // Weather mosaics alone still count as photos made public.
    const mosaics = new Set(report.captures.filter((c) => !isDetailed(c)).map((c) => c.id))
    const only: Report = {
      ...report,
      captures: report.captures.filter((c) => mosaics.has(c.id)),
      passes: report.passes.filter((p: Pass) => p.verdict !== 'imaged' || (p.captureId && mosaics.has(p.captureId))),
    }
    const f = summaryFacts(only, 'Waterloo', meta)
    expect(f.counts.imaged).toBe(headline(only, meta).images)
    expect(f.counts.imaged).toBeGreaterThan(0)
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: f.satellites, photos: f.counts.imaged })).toMatch(/ images? (was|were) made public\.\n/)
  })
})

describe('the week’s card shows the gallery’s first image, labelled as the gallery labels it (owner)', () => {
  const META: Record<number, SatMeta> = {
    60989: { norad: 60989, name: 'Sentinel-2C', category: 'open-optical' },
    42063: { norad: 42063, name: 'Sentinel-2B', category: 'open-optical' },
    49260: { norad: 49260, name: 'Landsat 9', category: 'open-optical' },
  }
  const meta = (n: number): SatMeta => META[n] ?? { norad: n, name: `NORAD ${n}`, category: 'other' }
  const T_CLEAR = Date.UTC(2026, 10, 3, 13, 36)
  const chipText = (c: { segs: { text: string }[] }) => c.segs.map((x) => x.text).join('')
  const LS9 = 'LC09_L2SP_224078_20261103_02_T1'

  it('a cloudy week: the last clear look from before it, with its day, in the card, the link and the server', async () => {
    const { summaryFromParams, summaryDescription } = await server()
    const report = await waterlooReport({ withTracks: false })
    // Every detailed photo of the week clouded over; a clear Landsat 9 scene from before the window.
    const cloudy: Report = { ...report, captures: report.captures.map((c) => (isDetailed(c) ? { ...c, spot: 'cloud' as const, cloudCoverPct: 95 } : c)) }
    const ls = report.captures.find((c) => isDetailed(c))!
    const clearCover: Capture = { ...ls, id: LS9, itemId: LS9, collection: 'landsat-c2-l2', platform: 'landsat-9', norad: 49260, gsdM: 30, datetime: T_CLEAR, spot: 'clear', cloudCoverPct: 2 }
    const f = summaryFacts({ ...cloudy, clearCover }, 'Waterloo', meta)
    expect(f.best).toMatchObject({ itemId: LS9, satName: 'Landsat 9', tClosest: T_CLEAR, look: 'lastClear' })
    const spec = summaryCardSpec({ ...cloudy, clearCover }, 'Waterloo', meta, 'America/Toronto', 'www.watched.earth')
    expect(spec.plate.kind === 'image' && chipText(spec.plate.chip)).toBe('Last clear look · 3 Nov · Landsat 9 · 30 m')
    const link = new URL(summaryLink('https://www.watched.earth', f))
    expect(link.searchParams.get('bw')).toBe('lc')
    const back = summaryFromParams(link.searchParams) as Parameters<typeof buildSummarySpec>[0]
    expect(back.best?.look).toBe('lastClear')
    const fromLink = buildSummarySpec({ ...back, timeZone: 'America/Toronto', host: 'www.watched.earth' }).plate
    expect(fromLink.kind === 'image' && chipText(fromLink.chip)).toBe('Last clear look · 3 Nov · Landsat 9 · 30 m')
    expect(summaryDescription(back)).toContain('The last clear look is from Landsat 9.')
  })

  it('a week with a clear photo: the closest look, as before (no extra link parameter)', async () => {
    const report = await waterlooReport({ withTracks: false })
    const f = summaryFacts(report, 'Waterloo', meta)
    expect(f.best?.look).toBe('closest')
    expect(new URL(summaryLink('https://www.watched.earth', f)).searchParams.get('bw')).toBeNull()
    const spec = summaryCardSpec(report, 'Waterloo', meta, 'America/Toronto', 'www.watched.earth')
    expect(spec.plate.kind === 'image' && chipText(spec.plate.chip)).toMatch(/^Closest look · /)
  })
})
