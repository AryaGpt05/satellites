import { describe, expect, it, vi } from 'vitest'
import type { Capture, LatLon, SpotCloud } from '@/types'
import clearS2 from '@/imagery/__fixtures__/pc-clear-sentinel-2-l2a-waterloo.json'
import clearLs from '@/imagery/__fixtures__/pc-clear-landsat-c2-l2-waterloo.json'
import { pcItemToCandidate, type StacItemCollection } from '@/imagery/stac'
import { isCloudedCapture, needsClearCover, pickClearCover, startClearCover, type ClearCoverDeps } from './clearCover'

const WATERLOO: LatLon = { lat: 43.4723, lon: -80.5449 }
const DAY = 86_400_000
const WINDOW_START = Date.parse('2026-11-01T17:37:00Z')

/** The recorded Planetary Computer answers (scene cloud < 20 %, Sep–Oct 2026), as captures, newest first. */
const scenes: Capture[] = [clearS2, clearLs]
  .flatMap((fc) => (fc as unknown as StacItemCollection).features)
  .map((it) => pcItemToCandidate(it, WATERLOO)!.capture)
  .sort((a, b) => b.datetime - a.datetime)

function cap(over: Partial<Capture> & Pick<Capture, 'id'>): Capture {
  return {
    provider: 'planetary-computer',
    collection: 'sentinel-2-l2a',
    itemId: over.id,
    platform: 'sentinel-2c',
    datetime: WINDOW_START + DAY,
    gsdM: 10,
    cropUrl: () => 'about:blank',
    ...over,
  }
}

describe('needsClearCover (the results rule: clouded = cloud at the spot or scene ≥ 70 %)', () => {
  it('is false when an imaged pass has a clear (or unchecked, mostly clear) detailed photo', () => {
    const clear = cap({ id: 'A', cloudCoverPct: 30 })
    expect(needsClearCover([{ verdict: 'imaged', captureId: 'A' }], [clear])).toBe(false)
    expect(needsClearCover([{ verdict: 'imaged', captureId: 'A' }], [{ ...clear, spot: 'cirrus' }])).toBe(false)
  })
  it('is true for a week of clouded photos, weather mosaics only, or no photo at all', () => {
    const white = cap({ id: 'W', cloudCoverPct: 96 })
    const spotted = cap({ id: 'S', cloudCoverPct: 12, spot: 'cloud' })
    const mosaic = cap({ id: 'M', provider: 'gibs', collection: 'gibs-viirs-noaa20' as Capture['collection'], gsdM: 375 })
    expect(isCloudedCapture(white)).toBe(true)
    expect(isCloudedCapture(spotted)).toBe(true)
    expect(
      needsClearCover(
        [
          { verdict: 'imaged', captureId: 'W' },
          { verdict: 'imaged', captureId: 'S' },
          { verdict: 'imaged', captureId: 'M' },
        ],
        [white, spotted, mosaic],
      ),
    ).toBe(true)
    expect(needsClearCover([], [])).toBe(true)
    // A clear scene that matched no imaged pass is not a photo of the window.
    expect(needsClearCover([{ verdict: 'likely' }], [cap({ id: 'A', cloudCoverPct: 3 })])).toBe(true)
  })
})

describe('pickClearCover', () => {
  it('keeps the newest candidate whose spot is clear or cirrus, checking newest first', async () => {
    const spot = vi.fn(async (c: Capture): Promise<SpotCloud> => (c.itemId.startsWith('S2A_MSIL2A_20261024') ? 'cloud' : c.itemId.startsWith('S2C_MSIL2A_20261022') ? 'cirrus' : 'clear'))
    const got = await pickClearCover(scenes, WATERLOO, WINDOW_START, spot)
    // 24 Oct is clouded at the spot; the next newest is 23 Oct (Landsat 8), which reads clear.
    expect(got?.itemId).toBe('LC08_L2SP_018030_20261023_02_T1')
    expect(got?.spot).toBe('clear')
    // One round of four, newest first.
    expect(spot.mock.calls.map(([c]) => c.itemId)).toEqual(scenes.slice(0, 4).map((c) => c.itemId))
    // The candidate list itself is never mutated.
    expect(scenes.every((c) => c.spot === undefined)).toBe(true)
  })

  it('tries a second round, and gives up after eight checks', async () => {
    const spot = vi.fn(async (): Promise<SpotCloud> => 'cloud')
    expect(await pickClearCover(scenes, WATERLOO, WINDOW_START, spot)).toBeUndefined()
    expect(spot).toHaveBeenCalledTimes(8)
    const second = vi.fn(async (c: Capture): Promise<SpotCloud> => (c.itemId === scenes[5].itemId ? 'clear' : 'shadow'))
    expect((await pickClearCover(scenes, WATERLOO, WINDOW_START, second))?.itemId).toBe(scenes[5].itemId)
  })

  it('never offers a scene from inside the window, and an unreachable spot check is not "clear"', async () => {
    const inside = cap({ id: 'IN', datetime: WINDOW_START + 1000, cloudCoverPct: 1 })
    const spot = vi.fn(async (c: Capture): Promise<SpotCloud> => {
      if (c.id === 'IN') return 'clear'
      throw new Error('503')
    })
    expect(await pickClearCover([inside, ...scenes.slice(0, 2)], WATERLOO, WINDOW_START, spot)).toBeUndefined()
    expect(spot.mock.calls.map(([c]) => c.id)).not.toContain('IN')
  })

  it('rejects on abort', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const spot = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError')
    })
    await expect(pickClearCover(scenes, WATERLOO, WINDOW_START, spot, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('startClearCover', () => {
  it('lists the 60 days before the window up front, and checks spots only when asked', async () => {
    const deps: ClearCoverDeps = { search: vi.fn(async () => scenes), spot: vi.fn(async (): Promise<SpotCloud> => 'clear') }
    const leg = startClearCover(WATERLOO, WINDOW_START, undefined, deps)
    expect(deps.search).toHaveBeenCalledWith(WATERLOO, WINDOW_START - 60 * DAY, WINDOW_START)
    await Promise.resolve()
    expect(deps.spot).not.toHaveBeenCalled()
    expect((await leg.pick())?.itemId).toBe(scenes[0].itemId)
  })

  it('a failed listing resolves to no cover', async () => {
    const deps: ClearCoverDeps = { search: vi.fn(async () => Promise.reject(new Error('down'))), spot: vi.fn(async (): Promise<SpotCloud> => 'clear') }
    await expect(startClearCover(WATERLOO, WINDOW_START, undefined, deps).pick()).resolves.toBeUndefined()
  })
})
