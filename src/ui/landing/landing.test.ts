import { describe, expect, it } from 'vitest'
import { balancePad } from './balance'
import { canSubmitQuery, clampActive, enterTarget, isTypingTarget, stepActive } from './listNav'
import { EXAMPLE_PLACES } from './places'
import { windowLabel } from './windowLabel'

describe('combobox keyboard model', () => {
  it('steps down and up with wrap through "none"', () => {
    expect(stepActive(-1, 3, 1)).toBe(0)
    expect(stepActive(0, 3, 1)).toBe(1)
    expect(stepActive(2, 3, 1)).toBe(-1)
    expect(stepActive(-1, 3, -1)).toBe(2)
    expect(stepActive(0, 3, -1)).toBe(-1)
    expect(stepActive(-1, 0, 1)).toBe(-1)
  })
  it('enter picks the highlight, else the first result', () => {
    expect(enterTarget(-1, 4)).toBe(0)
    expect(enterTarget(2, 4)).toBe(2)
    expect(enterTarget(9, 4)).toBe(0)
    expect(enterTarget(-1, 0)).toBe(-1)
  })
  it('drops a highlight that fell off the end of a new list', () => {
    expect(clampActive(3, 2)).toBe(-1)
    expect(clampActive(1, 2)).toBe(1)
  })
  it('detects typing targets without a DOM', () => {
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget({ closest: () => ({}) } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget({ closest: () => null } as unknown as EventTarget)).toBe(false)
  })
})

describe('example places', () => {
  it('are real coordinates with distinct labels', () => {
    expect(EXAMPLE_PLACES).toHaveLength(5)
    expect(new Set(EXAMPLE_PLACES.map((p) => p.chip)).size).toBe(5)
    for (const p of EXAMPLE_PLACES) {
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(90)
      expect(Math.abs(p.lon)).toBeLessThanOrEqual(180)
      expect(p.label.length).toBeGreaterThan(2)
      expect(p.source).toBe('demo')
      expect(p.countryCode).toMatch(/^[a-z]{2}$/)
    }
  })
  it('spans hemispheres', () => {
    expect(EXAMPLE_PLACES.some((p) => p.lat < 0)).toBe(true)
    expect(EXAMPLE_PLACES.some((p) => p.lon > 90)).toBe(true)
    expect(EXAMPLE_PLACES.some((p) => p.lon < -60)).toBe(true)
  })
  it('stays out of the polar night (every chip must be able to deliver a picture in winter)', () => {
    for (const p of EXAMPLE_PLACES) expect(Math.abs(p.lat)).toBeLessThan(60)
    expect(EXAMPLE_PLACES.map((p) => p.chip)).toContain('Palm Jumeirah')
  })
})

describe('window label', () => {
  it('formats the trailing 7-day window in UTC, in the one date style', () => {
    // same month: written once; days never zero-padded
    expect(windowLabel(Date.UTC(2026, 10, 8, 4, 0))).toBe('1 → 8 NOV 2026 UTC')
    // across a month
    expect(windowLabel(Date.UTC(2026, 10, 5, 12, 0))).toBe('29 OCT → 5 NOV 2026 UTC')
    // across a year: the year on both ends
    expect(windowLabel(Date.UTC(2027, 0, 5, 12, 0))).toBe('29 DEC 2026 → 5 JAN 2027 UTC')
    expect(windowLabel(Date.UTC(2027, 0, 3, 12, 0))).toBe('27 DEC 2026 → 3 JAN 2027 UTC')
  })
  it('uses the UTC day, whatever the hour', () => {
    expect(windowLabel(Date.UTC(2026, 10, 8, 23, 59))).toBe('1 → 8 NOV 2026 UTC')
    expect(windowLabel(Date.UTC(2026, 10, 9, 0, 0))).toBe('2 → 9 NOV 2026 UTC')
  })
})

describe('primary action availability', () => {
  it('needs a query of the minimum length', () => {
    expect(canSubmitQuery('', 2, null)).toBe(false)
    expect(canSubmitQuery(' a ', 2, null)).toBe(false)
    expect(canSubmitQuery('Wa', 2, null)).toBe(true)
  })
  it('is withheld only when the answer for exactly this query was empty', () => {
    expect(canSubmitQuery('qqqzzxv', 2, { q: 'qqqzzxv', count: 0 })).toBe(false)
    expect(canSubmitQuery('qqqzzxv ', 2, { q: 'qqqzzxv', count: 0 })).toBe(false)
    expect(canSubmitQuery('Waterloo', 2, { q: 'Waterloo', count: 6 })).toBe(true)
    // typing on after an empty answer: offer it again (Enter searches the new text)
    expect(canSubmitQuery('qqqzzxva', 2, { q: 'qqqzzxv', count: 0 })).toBe(true)
  })
})

describe('hero balance', () => {
  // column 740 px tall, idle content 640 px
  it('absorbs a note that fits by padding the top by its height', () => {
    expect(balancePad(740, 688, 640, 48)).toBe(48)
  })
  it('absorbs only as much as the free space below allows', () => {
    expect(balancePad(740, 715, 640, 75)).toBe(25)
    expect(balancePad(560, 600, 525, 75)).toBe(0)
  })
  it('pads the bottom when the note replaces something taller (content shrank)', () => {
    expect(balancePad(560, 510, 525, 75)).toBe(-15)
  })
  it('does nothing without a note, and assumes pure growth before the first idle measurement', () => {
    expect(balancePad(740, 640, 640, 0)).toBe(0)
    expect(balancePad(740, 688, null, 48)).toBe(48)
  })
})
