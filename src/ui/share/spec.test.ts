/**
 * One card, three renderers (share SH2): the spec the app builds for a pass (preview + PNG) must be
 * field-identical to the one the server builds for the stored share (Open Graph card), and the shared
 * builder must speak the app's vocabulary and time format.
 */
import { describe, expect, it } from 'vitest'
import type { Pass, Report } from '@/types'
import { buildCardSpec, headlineParts, localStamp, zoneAbbr as specZoneAbbr, type CardInput, type CardSpec, type SummaryInput } from '../../../api/_lib/cardSpec'
import { waterlooReport } from '../results/__fixtures__/waterloo'
import { shareHeadline } from '../results/lib/copy'
import { VERDICT_META, VERDICTS, type SatMeta } from '../results/lib/meta'
import { fmtLocalDay, fmtLocalTime, zoneAbbr } from '../results/lib/time'
import { PLATE, buildSummarySpec, cornerTickPrim } from '../../../api/_lib/cardSpec'
import { cardSpec, summaryCardSpec, summaryFacts } from './card'
import { roundedPlace, summaryLink, summaryPostText } from './links'

// The server module reads process.env and tz-lookup: imported by a runtime specifier so the app's
// tsconfig (browser types) never type-checks it from here.
interface ServerShare {
  shareFromRpc: (v: unknown) => unknown
  cardInputFromShare: (s: unknown, host: string) => CardInput
  summaryFromParams: (q: URLSearchParams) => (Omit<SummaryInput, 'host' | 'timeZone'> & { place: unknown }) | null
  shareTimeZone: (p: { lat: number; lon: number }) => string
}
const server = () => import('../../../api/_lib/share.ts' as string) as Promise<ServerShare>

const META: Record<number, SatMeta> = {
  60989: { norad: 60989, name: 'Sentinel-2C', category: 'open-optical' },
  42063: { norad: 42063, name: 'Sentinel-2B', category: 'open-optical' },
}
const metaFor = (p: Pass): SatMeta => META[p.norad] ?? { norad: p.norad, name: `NORAD ${p.norad}`, category: 'other' }

/** What create_share stores for this pass (the server re-reads it as a ShareRecord). */
function storedShare(report: Report, pass: Pass) {
  const r = roundedPlace(report.place.lat, report.place.lon)
  const c = report.captures.find((x) => x.id === pass.captureId)
  return {
    placeLabel: report.place.label,
    lat: r.lat,
    lon: r.lon,
    norad: pass.norad,
    satName: metaFor(pass).name,
    verdict: pass.verdict,
    tClosest: pass.tClosest,
    capture: c
      ? { collection: c.collection, itemId: c.itemId, provider: c.provider, platform: c.platform, datetime: c.datetime, cloudCoverPct: c.cloudCoverPct, gsdM: c.gsdM }
      : undefined,
    pass: { ...pass, track: undefined },
  }
}

const strip = (s: CardSpec) => {
  const out = structuredClone(s) as CardSpec
  if (out.plate.kind === 'image') delete out.plate.imageUrl
  return out
}

describe('share card spec', () => {
  it('builds the same card in the app and on the server', async () => {
    const { shareFromRpc, cardInputFromShare } = await server()
    const report = await waterlooReport({ withTracks: false })
    const picks = [
      report.passes.find((p) => p.captureId?.startsWith('S2C_MSIL2A_20261101')),
      report.passes.find((p) => p.captureId?.startsWith('S2B_MSIL2A_20261030')), // 81 % cloud: the clouded card
      report.passes.find((p) => p.verdict === 'could'),
      report.passes.find((p) => p.verdict === 'overhead'),
      report.passes.find((p) => p.verdict === 'likely'),
    ].filter((p): p is Pass => !!p)
    expect(picks.length).toBe(5)
    for (const pass of picks) {
      const c = report.captures.find((x) => x.id === pass.captureId)
      const client = cardSpec(pass, report, metaFor(pass), 'America/Toronto', 'overflight.app', { clouded: (c?.cloudCoverPct ?? 0) >= 70 })
      const record = shareFromRpc({ id: 'ab3d5f7h', ...storedShare(report, pass) })
      expect(record).toBeTruthy()
      const srv = buildCardSpec(cardInputFromShare(record, 'overflight.app'))
      expect(strip(srv)).toEqual(strip(client))
    }
  })

  it('builds the same summary card from the report and from its link (SH6)', async () => {
    const { summaryFromParams, shareTimeZone } = await server()
    const report = await waterlooReport({ withTracks: false })
    const name = (n: number) => (META[n] ?? { name: `NORAD ${n}` }).name
    const client = summaryCardSpec(report, 'Waterloo', name, 'America/Toronto', 'overflight.app')
    const link = summaryLink('https://overflight.app', summaryFacts(report, 'Waterloo', name))
    expect(link).not.toContain('43.4723')
    const sum = summaryFromParams(new URL(link).searchParams)!
    expect(sum).toBeTruthy()
    const { place: _place, ...input } = sum
    void _place
    const srv = buildSummarySpec({ ...input, timeZone: shareTimeZone(sum), host: 'overflight.app' })
    expect(strip(srv)).toEqual(strip(client))
    expect(client.lead).toMatch(/^\d+ satellites photographed$/)
    expect(client.readouts.map((r) => r.label)).toEqual(['Photo', 'Likely', 'Could', 'Overhead'])
    expect(summaryPostText({ placeLabel: 'Waterloo', satellites: 7, passes: 1800, best: { satName: 'Sentinel-2C', altitudeKm: 795 } })).toBe(
      '7 satellites photographed Waterloo this week. The clearest one, Sentinel-2C, from 795 km up.\n\nSomething watched you this week too.',
    )
  })

  it('carries the credit, local time, footer and the clouded variant', async () => {
    const report = await waterlooReport({ withTracks: false })
    const s2 = report.passes.find((p) => p.captureId?.startsWith('S2C_MSIL2A_20261101'))!
    const spec = cardSpec(s2, report, metaFor(s2), 'America/Toronto', 'overflight.app')
    expect(spec.stamp).toBe(`${fmtLocalDay(s2.tClosest, 'America/Toronto')} 2026 · ${fmtLocalTime(s2.tClosest, 'America/Toronto')} EST`)
    expect(spec.footLeft).toBe('See what watched you')
    expect(spec.plate.kind).toBe('image')
    if (spec.plate.kind === 'image') {
      expect(spec.plate.credit.segs[0].text).toBe('Contains modified Copernicus Sentinel data 2026')
      expect(spec.plate.chip.segs[0].text).toBe('Sentinel-2C · MSI · 10 m')
      expect(spec.plate.imageUrl).toMatch(/\/630x630\.jpg\?collection=sentinel-2-l2a&item=S2C_MSIL2A_20261101/)
      expect(spec.plate.clouded).toBeUndefined()
    }
    const cloudy = report.passes.find((p) => p.captureId?.startsWith('S2B_MSIL2A_20261030'))!
    const cs = cardSpec(cloudy, report, metaFor(cloudy), 'America/Toronto', 'overflight.app', { clouded: true })
    expect(cs.sub).toBe('Clouded over. It saw only cloud.')
    expect(cs.plate.kind === 'image' && cs.plate.clouded?.segs[0].text).toBe('Clouded over · 81%')
  })

  it('puts viewfinder ticks only in corners no chip holds, on the chips’ 24px inset', async () => {
    const report = await waterlooReport({ withTracks: false })
    const s2 = report.passes.find((p) => p.captureId?.startsWith('S2C_MSIL2A_20261101'))!
    const spec = cardSpec(s2, report, metaFor(s2), 'America/Toronto', 'overflight.app')
    const br = (cornerTickPrim(PLATE, 25, 16, '', 2, ['br']) as { d: string }).d
    const tickD = (prims: { t: string; d?: string }[]) => prims.filter((p) => p.t === 'path' && /^M\d+ \d+[VH]\d+[VH]\d+$/.test(p.d ?? '')).map((p) => p.d)
    // Source chip (top left), scale bar (top right), credit (bottom left): one tick, bottom right.
    expect(spec.plate.kind === 'image' && tickD(spec.plate.overlay)).toEqual([br])
    // The geometry plate holds the same three corners.
    const could = report.passes.find((p) => p.verdict === 'could')!
    const plan = cardSpec(could, report, metaFor(could), 'America/Toronto', 'overflight.app').plate
    expect(plan.kind === 'plan' && tickD(plan.prims)).toEqual([br])
  })

  it('steps the summary counts down when one runs to six characters', () => {
    const base = { placeLabel: 'Waterloo', lat: 43.47, lon: -80.54, satellites: 7, host: '' }
    expect(buildSummarySpec({ ...base, counts: { imaged: 31, likely: 220, could: 1544, overhead: 66 } }).readoutSize).toBe(26)
    expect(buildSummarySpec({ ...base, counts: { imaged: 31, likely: 220, could: 12544, overhead: 66 } }).readoutSize).toBeLessThan(26)
  })

  it('speaks the one vocabulary and the app’s time format', () => {
    for (const v of VERDICTS) {
      const a = headlineParts(v, 'Sentinel-2C', 'Waterloo')
      expect(a.lead).toBe(shareHeadline(v, 'Sentinel-2C', 'Waterloo').lead)
      expect(buildCardSpec({ verdict: v, satName: 'X', placeLabel: 'Y', lat: 0, lon: 0, pass: {}, host: '' }).verdictLabel).toBe(VERDICT_META[v].title)
    }
    const zones = ['America/Toronto', 'Europe/London', 'Europe/Berlin', 'Australia/Sydney', 'Asia/Tokyo', 'Asia/Kolkata', 'America/Sao_Paulo', 'Etc/GMT+9', 'UTC', 'Africa/Cairo']
    for (const tz of zones) {
      for (const t of [Date.UTC(2026, 0, 15, 12), Date.UTC(2026, 6, 15, 3, 7), Date.UTC(2026, 10, 1, 16, 21)]) {
        expect(specZoneAbbr(t, tz)).toBe(zoneAbbr(t, tz))
        expect(localStamp(t, tz)).toBe(`${fmtLocalDay(t, tz)} ${new Date(t + 0).getUTCFullYear() === 2026 ? '2026' : ''} · ${fmtLocalTime(t, tz)} ${zoneAbbr(t, tz)}`)
      }
    }
  })
})
