import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capture, LatLon, Pass, Place } from '@/types'

// The imagery module is mocked: these tests exercise orchestration and matching, not the network.
const imagery = vi.hoisted(() => ({
  searchCapturesDetailed: vi.fn(),
  weatherCaptures: vi.fn(),
}))
vi.mock('@/imagery', () => imagery)

import { getRow, getSatInfo, satrecFor } from './catalog'
import { findPassesForSat, passTargetFor } from './passes'
import { computeReport } from './report'
import { loadTestCatalog, TOKYO, WATERLOO } from './testing'

let now: number
const waterloo: Place = { label: 'Waterloo', ...WATERLOO, source: 'demo' }
const tokyo: Place = { label: 'Tokyo', ...TOKYO, source: 'demo' }

function passesOf(norad: number, place: LatLon): Pass[] {
  const t = passTargetFor(getSatInfo(norad)!, getRow(norad)!)!
  return findPassesForSat(satrecFor(norad)!, t, { place, t0: now - 7 * 86_400_000, t1: now })
}

function capture(over: Partial<Capture> & Pick<Capture, 'id' | 'platform' | 'datetime' | 'collection'>): Capture {
  return {
    provider: 'planetary-computer',
    itemId: over.id,
    gsdM: 10,
    cropUrl: () => 'about:blank',
    ...over,
  }
}

beforeAll(() => {
  const cat = loadTestCatalog()
  now = Date.parse(cat.fetchedAt)
})
beforeEach(() => {
  imagery.searchCapturesDetailed.mockReset()
  imagery.weatherCaptures.mockReset()
})

describe('computeReport', () => {
  it('upgrades the matching pass to imaged and keeps everything else', async () => {
    const s2c = passesOf(60989, WATERLOO)
    expect(s2c.length).toBeGreaterThan(0)
    const target = s2c[s2c.length - 1]
    // Sentinel-2 archive times are the datatake start, minutes before the overflight.
    const scene = capture({ id: 'S2C_TEST', platform: 'sentinel-2c', collection: 'sentinel-2-l2a', datetime: target.tClosest - 7 * 60_000, cloudCoverPct: 12 })
    imagery.searchCapturesDetailed.mockResolvedValue({ captures: [scene], degraded: [] })
    imagery.weatherCaptures.mockResolvedValue([])

    const stages: string[] = []
    const report = await computeReport(waterloo, { now, onProgress: (e) => stages.push(e.stage) })

    const imaged = report.passes.filter((p) => p.verdict === 'imaged')
    expect(imaged).toHaveLength(1)
    expect(imaged[0].norad).toBe(60989)
    expect(imaged[0].captureId).toBe('S2C_TEST')
    expect(Math.abs(imaged[0].tClosest - target.tClosest)).toBeLessThan(1000)
    expect(report.captures.map((c) => c.id)).toEqual(['S2C_TEST'])
    expect(report.counts.imaged).toBe(1)
    expect(report.counts.passes).toBe(report.passes.length)
    expect(report.counts.imaged + report.counts.likely + report.counts.could + report.counts.overhead).toBe(report.passes.length)
    expect(report.counts.satellitesConsidered).toBeGreaterThan(300)
    for (let i = 1; i < report.passes.length; i++) expect(report.passes[i].tClosest).toBeGreaterThanOrEqual(report.passes[i - 1].tClosest)
    for (const p of report.passes) {
      expect(p.tClosest).toBeGreaterThanOrEqual(report.windowStart)
      expect(p.tClosest).toBeLessThanOrEqual(report.windowEnd)
    }
    expect(new Set(report.passes.map((p) => p.id)).size).toBe(report.passes.length)
    expect(stages[0]).toBe('catalog')
    expect(stages).toContain('propagate')
    expect(stages).toContain('match')
    expect(stages[stages.length - 1]).toBe('done')
    expect(report.notes).toEqual([])
    console.log(
      `Waterloo: ${report.passes.length} passes in ${report.timings.totalMs.toFixed(0)} ms ` +
        `(passes ${report.timings.passesMs.toFixed(0)} ms, ${report.timings.workers} workers)`,
    )
  })

  it('adds a pass for a scene that no prediction qualified for', async () => {
    // Sentinel-2A over Tokyo at night: no daylight pass qualifies, but pretend the archive holds a scene.
    const t = passTargetFor(getSatInfo(40697)!, getRow(40697)!)!
    const geomOnly = findPassesForSat(satrecFor(40697)!, { ...t, category: 'radar' }, { place: TOKYO, t0: now - 7 * 86_400_000, t1: now })
    const night = geomOnly.find((p) => p.sunElevationDeg < 0 && p.inFieldOfRegard)
    expect(night).toBeDefined()
    imagery.searchCapturesDetailed.mockResolvedValue({
      captures: [capture({ id: 'S2A_NIGHT', platform: 'sentinel-2a', collection: 'sentinel-2-l2a', datetime: night!.tClosest - 3 * 60_000 })],
      degraded: [],
    })
    imagery.weatherCaptures.mockResolvedValue([])
    const report = await computeReport(tokyo, { now })
    const added = report.passes.find((p) => p.captureId === 'S2A_NIGHT')
    expect(added).toBeDefined()
    expect(added!.verdict).toBe('imaged')
    expect(Math.abs(added!.tClosest - night!.tClosest)).toBeLessThan(1000)
  })

  it('matches a scene whose datatake started up to an hour before the overflight', async () => {
    const s2c = passesOf(60989, WATERLOO)
    const target = s2c[0]
    const scene = capture({ id: 'S2C_LONG', platform: 'sentinel-2c', collection: 'sentinel-2-l2a', datetime: target.tClosest - 55 * 60_000 })
    imagery.searchCapturesDetailed.mockResolvedValue({ captures: [scene], degraded: [] })
    imagery.weatherCaptures.mockResolvedValue([])
    const report = await computeReport(waterloo, { now })
    const imaged = report.passes.filter((p) => p.captureId === 'S2C_LONG')
    expect(imaged).toHaveLength(1)
    expect(imaged[0].id).toBe(target.id)
  })

  it('never invents a pass for a scene with no overflight in its window', async () => {
    // A Sentinel-2A "scene" stamped 30 min after a real Tokyo overflight: the window [+20, +90] min
    // holds no approach (the next orbit is ~100 min later), so the minimum sits on the window edge.
    const t = passTargetFor(getSatInfo(40697)!, getRow(40697)!)!
    const any = findPassesForSat(satrecFor(40697)!, { ...t, category: 'radar' }, { place: TOKYO, t0: now - 7 * 86_400_000, t1: now })[0]
    imagery.searchCapturesDetailed.mockResolvedValue({
      captures: [capture({ id: 'S2A_GHOST', platform: 'sentinel-2a', collection: 'sentinel-2-l2a', datetime: any.tClosest + 30 * 60_000 })],
      degraded: [],
    })
    imagery.weatherCaptures.mockResolvedValue([])
    const report = await computeReport(tokyo, { now })
    expect(report.passes.find((p) => p.captureId === 'S2A_GHOST')).toBeUndefined()
  })

  it('matches a GIBS daily mosaic to its weather pass', async () => {
    const noaa = passesOf(43013, WATERLOO).filter((p) => p.sunElevationDeg > 5)
    expect(noaa.length).toBeGreaterThan(0)
    const p = noaa[0]
    imagery.searchCapturesDetailed.mockResolvedValue({ captures: [], degraded: [] })
    const calls: number[][] = []
    imagery.weatherCaptures.mockImplementation(async (_place: LatLon, passes: Pass[]) => {
      calls.push([...new Set(passes.map((x) => x.norad))])
      if (!passes.some((x) => x.id === p.id)) return []
      return [capture({ id: 'VIIRS@day', provider: 'gibs', platform: 'noaa-20', collection: 'gibs-viirs-noaa20', norad: 43013, datetime: p.tClosest, gsdM: 375 })]
    })
    const report = await computeReport(waterloo, { now })
    const imaged = report.passes.filter((x) => x.verdict === 'imaged')
    expect(imaged).toHaveLength(1)
    expect(imaged[0].norad).toBe(43013)
    expect(imaged[0].captureId).toBe('VIIRS@day')
    expect(report.captures.map((c) => c.id)).toEqual(['VIIRS@day'])
    // One call per (GIBS satellite, UTC day): NOAA-20, NOAA-21, Suomi NPP, Terra, Aqua over 7–8 days.
    for (const c of calls) expect(c).toHaveLength(1)
    expect(new Set(calls.flat())).toEqual(new Set([43013, 54234, 37849, 25994, 27424]))
    expect(calls.length).toBeGreaterThanOrEqual(35)
    expect(calls.length).toBeLessThanOrEqual(40)
    expect(report.notes).toEqual([])
  })

  it('keeps what GIBS verified within the budget and drops the stragglers', async () => {
    imagery.searchCapturesDetailed.mockResolvedValue({ captures: [], degraded: [] })
    const aborted: number[] = []
    imagery.weatherCaptures.mockImplementation((_place: LatLon, passes: Pass[], signal?: AbortSignal) => {
      const p = passes.find((x) => x.inSwath && x.sunElevationDeg > 5)
      if (!p) return Promise.resolve([])
      // NOAA-20's probes hang until aborted; everyone else answers at once.
      if (p.norad === 43013) {
        return new Promise((_, reject) =>
          signal?.addEventListener('abort', () => {
            aborted.push(p.norad)
            reject(new DOMException('Aborted', 'AbortError'))
          }),
        )
      }
      return Promise.resolve([capture({ id: `G@${p.id}`, provider: 'gibs', platform: 'x', collection: 'gibs-modis-terra', norad: p.norad, datetime: p.tClosest, gsdM: 250 })])
    })
    const t0 = performance.now()
    const report = await computeReport(waterloo, { now, budgetMs: 200 })
    const elapsed = performance.now() - t0
    const imagedSats = new Set(report.passes.filter((p) => p.verdict === 'imaged').map((p) => p.norad))
    expect(imagedSats.has(43013)).toBe(false)
    expect(imagedSats.size).toBe(4)
    expect(aborted.length).toBeGreaterThan(0)
    expect(report.notes).toHaveLength(1)
    expect(report.notes[0]).toMatch(new RegExp(`did not return ${aborted.length} of \\d+ weather-satellite images in time`))
    // Never sooner than 1.2 s after the first probe, and not much later.
    expect(elapsed).toBeLessThan(report.timings.passesMs + 2500)
    expect(report.counts.imaged).toBe(report.passes.filter((p) => p.verdict === 'imaged').length)
  })

  for (const stage of ['propagate', 'archive'] as const) it(`aborts cleanly during the ${stage} stage (no unhandled rejections)`, async () => {
    // Node's process (vitest runs in node; the app tsconfig has no node types).
    const proc = (globalThis as unknown as { process: { on(e: string, f: (r: unknown) => void): void; off(e: string, f: (r: unknown) => void): void } }).process
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    proc.on('unhandledRejection', onUnhandled)
    const pendingUntilAbort = (_a: unknown, _b: unknown, _c: unknown, signal?: AbortSignal) =>
      new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
    imagery.searchCapturesDetailed.mockImplementation((place: unknown, a: unknown, b: unknown, signal?: AbortSignal) => pendingUntilAbort(place, a, b, signal))
    imagery.weatherCaptures.mockImplementation((place: unknown, passes: unknown, signal?: AbortSignal) => pendingUntilAbort(place, passes, null, signal))
    const ctl = new AbortController()
    const p = computeReport(waterloo, {
      now,
      signal: ctl.signal,
      onProgress: (e) => {
        if (e.stage === stage) setTimeout(() => ctl.abort(), 0)
      },
    })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 50))
    proc.off('unhandledRejection', onUnhandled)
    expect(unhandled).toEqual([])
  })

  it('survives a throwing callback', async () => {
    imagery.searchCapturesDetailed.mockResolvedValue({ captures: [], degraded: [] })
    imagery.weatherCaptures.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return []
    })
    const err = console.error
    console.error = () => undefined
    try {
      const report = await computeReport(waterloo, {
        now,
        onProgress: () => {
          throw new Error('ui bug')
        },
        onPartial: () => {
          throw new Error('ui bug')
        },
      })
      expect(report.passes.length).toBeGreaterThan(50)
    } finally {
      console.error = err
    }
  })

  it('delivers a partial report before the GIBS mosaics are verified', async () => {
    const p = passesOf(43013, WATERLOO).filter((x) => x.sunElevationDeg > 5)[0]
    imagery.searchCapturesDetailed.mockResolvedValue({ captures: [], degraded: [] })
    // GIBS answers only after the partial report was delivered (or after 3 s, so a bug can't hang the test).
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
      setTimeout(r, 3000)
    })
    imagery.weatherCaptures.mockImplementation(async (_place: LatLon, passes: Pass[]) => {
      await gate
      if (!passes.some((x) => x.id === p.id)) return []
      return [capture({ id: 'VIIRS@slow', provider: 'gibs', platform: 'noaa-20', collection: 'gibs-viirs-noaa20', norad: 43013, datetime: p.tClosest, gsdM: 375 })]
    })
    const partials: { imaged: number; partial: boolean; firstResultMs: number }[] = []
    const report = await computeReport(waterloo, {
      now,
      onPartial: (r) => {
        partials.push({ imaged: r.counts.imaged, partial: r.partial, firstResultMs: r.timings.firstResultMs })
        release()
      },
    })
    expect(partials).toHaveLength(1)
    expect(partials[0]).toMatchObject({ imaged: 0, partial: true })
    expect(report.partial).toBe(false)
    expect(report.counts.imaged).toBe(1)
    expect(report.timings.firstResultMs).toBe(partials[0].firstResultMs)
    expect(report.timings.firstResultMs).toBeLessThan(report.timings.totalMs)
  })

  it('degrades gracefully when the archives fail', async () => {
    imagery.searchCapturesDetailed.mockRejectedValue(new Error('network down'))
    imagery.weatherCaptures.mockRejectedValue(new Error('gibs down'))
    const report = await computeReport(waterloo, { now })
    expect(report.passes.length).toBeGreaterThan(50)
    expect(report.counts.imaged).toBe(0)
    expect(report.captures).toEqual([])
    expect(report.notes.length).toBe(2)
    expect(report.notes[1]).toMatch(/^NASA GIBS could not be reached/)
  })

  it('lists geostationary watchers with their real longitudes', async () => {
    imagery.searchCapturesDetailed.mockResolvedValue({ captures: [], degraded: [] })
    imagery.weatherCaptures.mockResolvedValue([])
    const w = await computeReport(waterloo, { now })
    const names = w.geo.map((g) => g.name)
    expect(names).toContain('GOES-19')
    expect(names).toContain('GOES-18')
    expect(names).not.toContain('Himawari-9')
    expect(names).not.toContain('GOES-16') // standby
    const g19 = w.geo.find((g) => g.name === 'GOES-19')!
    expect(g19.subLon).toBeGreaterThan(-80)
    expect(g19.subLon).toBeLessThan(-70)
    expect(g19.imagesInWindow).toBe(1008)
    expect(g19.gibs?.collection).toBe('gibs-goes-east')

    const t = await computeReport(tokyo, { now })
    const tn = t.geo.map((g) => g.name)
    expect(tn).toContain('Himawari-9')
    expect(tn).toContain('GEO-KOMPSAT-2A')
    expect(tn).toContain('Fengyun-4B')
    expect(tn).not.toContain('GOES-19')
    console.log('Tokyo geo:', t.geo.map((g) => `${g.name} ${g.subLon.toFixed(1)}° el ${g.elevationDeg.toFixed(1)}°`).join(', '))
  })

  it('rejects with AbortError when aborted', async () => {
    imagery.searchCapturesDetailed.mockImplementation(() => new Promise(() => undefined))
    imagery.weatherCaptures.mockResolvedValue([])
    const ctl = new AbortController()
    const p = computeReport(waterloo, { now, signal: ctl.signal })
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})
