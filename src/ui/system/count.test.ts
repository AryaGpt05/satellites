import { describe, expect, it } from 'vitest'
import { easeOut } from '@/lib/ease'
import { legDone, retarget, sampleLeg } from './count'

describe('Num count model', () => {
  it('eases from the start value to the target on --ease-out', () => {
    const leg = retarget(undefined, 100, 0, 700)
    expect(sampleLeg(leg, 0)).toBe(0)
    expect(sampleLeg(leg, 350)).toBeCloseTo(100 * easeOut(0.5), 6)
    expect(sampleLeg(leg, 700)).toBe(100)
    expect(legDone(leg, 699)).toBe(false)
    expect(legDone(leg, 700)).toBe(true)
  })

  it('holds the start value through a delay', () => {
    const leg = retarget(undefined, 50, 1000, 700, 200, 45)
    expect(sampleLeg(leg, 1000)).toBe(45)
    expect(sampleLeg(leg, 1200)).toBe(45)
    expect(sampleLeg(leg, 1900)).toBe(50)
  })

  it('re-targeted mid-count, continues from the value on screen (never snaps back)', () => {
    const a = retarget(undefined, 100, 0, 700)
    const shownAt300 = sampleLeg(a, 300)
    expect(shownAt300).toBeGreaterThan(50)
    const b = retarget(a, 200, 300, 700)
    // Continuity: the new leg starts exactly where the old one was.
    expect(b.from).toBeCloseTo(shownAt300, 9)
    expect(sampleLeg(b, 300)).toBeCloseTo(shownAt300, 9)
    // And moves on toward the new target, monotonically.
    let prev = shownAt300
    for (let t = 316; t <= 1000; t += 16) {
      const v = sampleLeg(b, t)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = v
    }
    expect(sampleLeg(b, 1000)).toBe(200)
  })

  it('re-targeted downward mid-count, also starts from the shown value', () => {
    const a = retarget(undefined, 248, 0, 700)
    const shown = sampleLeg(a, 200)
    const b = retarget(a, 226, 200, 700)
    expect(sampleLeg(b, 200)).toBeCloseTo(shown, 9)
    expect(sampleLeg(b, 900)).toBe(226)
  })
})
