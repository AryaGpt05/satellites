import { describe, expect, it } from 'vitest'
import { coverPinKey, pinCover, pinnedOrder } from './gallery'

const ph = (...keys: string[]) => keys.map((key) => ({ key }))
const keys = (a: { key: string }[]) => a.map((p) => p.key)

describe('the cover is chosen once (owner R-M1)', () => {
  const report = { windowEnd: 1_700_000_000_000, place: { lat: 43.4723, lon: -80.5449 } }
  const k = coverPinKey(report)

  it('keeps the photo the hero painted first, and puts a later cover right after it', () => {
    pinCover(k, 'S2B')
    // The final report: the last clear look leads, the clouded S2B is back in newest-first order.
    expect(keys(pinnedOrder(ph('LC09', 'M1', 'M2', 'S2B', 'S2C'), k))).toEqual(['S2B', 'LC09', 'M1', 'M2', 'S2C'])
  })

  it('only the first pin per report counts', () => {
    pinCover(k, 'LC09')
    expect(keys(pinnedOrder(ph('LC09', 'S2B'), k))).toEqual(['S2B', 'LC09'])
  })

  it('leaves the order alone when the pinned photo is first, gone, or nothing is pinned', () => {
    expect(keys(pinnedOrder(ph('S2B', 'M1'), k))).toEqual(['S2B', 'M1'])
    expect(keys(pinnedOrder(ph('LC09', 'M1'), k))).toEqual(['LC09', 'M1'])
    expect(keys(pinnedOrder(ph('A', 'B'), coverPinKey({ ...report, windowEnd: 1 })))).toEqual(['A', 'B'])
    expect(pinnedOrder([], k)).toEqual([])
  })

  it('a new search (a new window) starts a new pin', () => {
    const k2 = coverPinKey({ ...report, windowEnd: report.windowEnd + 60_000 })
    expect(k2).not.toBe(k)
    pinCover(k2, 'LC09')
    expect(keys(pinnedOrder(ph('LC09', 'S2B'), k2))).toEqual(['LC09', 'S2B'])
  })
})
