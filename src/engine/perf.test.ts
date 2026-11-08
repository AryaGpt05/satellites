import { describe, expect, it } from 'vitest'
import { getRow } from './catalog'
import { findPasses, passTargetFor, type PassTarget } from './passes'
import { loadTestCatalog, WATERLOO } from './testing'

describe('pass search throughput', () => {
  it('searches every candidate satellite over 7 days', () => {
    const cat = loadTestCatalog()
    const t1 = Date.parse(cat.fetchedAt)
    const targets = cat.sats.map((s) => passTargetFor(s, getRow(s.norad)!)).filter((t): t is PassTarget => !!t)
    const start = performance.now()
    const passes = findPasses(targets, { place: WATERLOO, t0: t1 - 7 * 86_400_000, t1 })
    const ms = performance.now() - start
    console.log(`${targets.length} satellites, ${passes.length} passes, ${ms.toFixed(0)} ms single-threaded`)
    expect(passes.length).toBeGreaterThan(100)
    // Budget: < 4 s on a laptop for the whole report; the pass search must leave most of it to the network.
    expect(ms).toBeLessThan(2500)
  })
})
