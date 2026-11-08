import { describe, expect, it } from 'vitest'
import { FLICK_PX_PER_MS, MIN_SNAP_PX, clampIndex, resolveSnap, rubberband, snapHeightsPx } from './sheetMath'

describe('snapHeightsPx', () => {
  it('turns fractions and px into ascending px heights', () => {
    expect(snapHeightsPx([0.6, 0.3, 0.92], 844)).toEqual([253, 506, 776])
    expect(snapHeightsPx([120, 0.5], 800)).toEqual([120, 400])
  })
  it('clamps to [MIN_SNAP_PX, max] and drops duplicates / junk', () => {
    expect(snapHeightsPx([0.01, 2000, NaN, -1, 0.5, 0.5], 800, 760)).toEqual([MIN_SNAP_PX, 400, 760])
  })
  it('never returns an empty list', () => {
    expect(snapHeightsPx([], 600)).toEqual([600])
  })
})

describe('resolveSnap', () => {
  const h = [253, 506, 776]
  it('settles on the nearest snap for a slow release', () => {
    expect(resolveSnap(h, 300, 0)).toBe(0)
    expect(resolveSnap(h, 400, 0.1)).toBe(1)
    expect(resolveSnap(h, 700, -0.1)).toBe(2)
  })
  it('moves one snap in the direction of a flick', () => {
    expect(resolveSnap(h, 520, FLICK_PX_PER_MS + 0.1)).toBe(2)
    expect(resolveSnap(h, 520, -(FLICK_PX_PER_MS + 0.1))).toBe(1)
    expect(resolveSnap(h, 500, -1)).toBe(0)
    expect(resolveSnap(h, 790, 2)).toBe(2)
    expect(resolveSnap(h, 200, -2)).toBe(0)
  })
  it('handles a single snap', () => {
    expect(resolveSnap([400], 10, -3)).toBe(0)
  })
})

describe('rubberband', () => {
  it('is ~1:1 for small pulls, monotonic, and bounded', () => {
    expect(rubberband(0)).toBe(0)
    expect(rubberband(-5)).toBe(0)
    expect(rubberband(4, 120)).toBeGreaterThan(3.8)
    expect(rubberband(100, 60)).toBeLessThan(60)
    expect(rubberband(200, 60)).toBeGreaterThan(rubberband(100, 60))
    expect(rubberband(1e6, 60)).toBeLessThan(60)
  })
})

describe('clampIndex', () => {
  it('clamps into range', () => {
    expect(clampIndex(-1, 3)).toBe(0)
    expect(clampIndex(7, 3)).toBe(2)
    expect(clampIndex(1.4, 3)).toBe(1)
  })
})
