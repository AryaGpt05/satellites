import { describe, expect, it } from 'vitest'
import { createLateShareGate } from './lateShare'

describe('late share gate (the landing keeps ?s= only while a late share may still open)', () => {
  const at = () => {
    let t = 0
    return { clock: () => t, set: (v: number) => void (t = v) }
  }

  it('pending from start until the lookup answers; the answer may open it', () => {
    const c = at()
    const g = createLateShareGate(c.clock)
    expect(g.pending()).toBe(false)
    g.start(15_000)
    c.set(6_000)
    expect(g.pending()).toBe(true)
    expect(g.answered()).toBe(true)
    expect(g.pending()).toBe(false)
  })

  it('the visitor’s own search ends it: their landing is clean and a later answer opens nothing', () => {
    const c = at()
    const g = createLateShareGate(c.clock)
    g.start(15_000)
    c.set(7_000)
    g.cancel() // runReport for a place they searched
    expect(g.pending()).toBe(false)
    expect(g.unresolved()).toBe(false)
    c.set(9_000)
    expect(g.answered()).toBe(false)
  })

  it('ends when its window closes, answered or not', () => {
    const c = at()
    const g = createLateShareGate(c.clock)
    g.start(15_000)
    c.set(15_001)
    expect(g.pending()).toBe(false)
    expect(g.answered()).toBe(false)
  })

  it('a late null (unknown share, or the lookup timing out at 12 s) can no longer open anything, but ?s= stays (CR-4)', () => {
    const c = at()
    const g = createLateShareGate(c.clock)
    g.start(15_000)
    expect(g.unresolved()).toBe(true)
    c.set(12_000) // get_share gives up: null
    g.answered() // the controller asks before it looks at the answer
    expect(g.pending()).toBe(false)
    expect(g.unresolved()).toBe(true) // a reload may still find it
    g.cancel() // the visitor's own search
    expect(g.unresolved()).toBe(false)
  })

  it('no answer at all: pending ends with the window, ?s= stays until the visitor’s own search', () => {
    const c = at()
    const g = createLateShareGate(c.clock)
    g.start(15_000)
    c.set(14_999)
    expect(g.pending()).toBe(true)
    c.set(15_001)
    expect(g.pending()).toBe(false)
    expect(g.unresolved()).toBe(true)
    g.cancel()
    expect(g.unresolved()).toBe(false)
  })
})
