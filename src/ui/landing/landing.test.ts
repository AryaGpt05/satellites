import { describe, expect, it } from 'vitest'
import { clampActive, enterTarget, isTypingTarget, stepActive } from './listNav'
import { EXAMPLE_PLACES } from './places'
import { validStats } from './stats'
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
    expect(EXAMPLE_PLACES.some((p) => p.lat > 66.5)).toBe(true)
  })
})

describe('window label', () => {
  it('formats the trailing 7-day window in UTC', () => {
    expect(windowLabel(Date.UTC(2026, 10, 8, 4, 0))).toBe('01 NOV → 08 NOV 2026 UTC')
    expect(windowLabel(Date.UTC(2027, 0, 3, 12, 0))).toBe('27 DEC 2026 → 03 JAN 2027 UTC')
  })
})

describe('lookup stats guard', () => {
  it('accepts only real, consistent counts', () => {
    expect(validStats({ total: 1204, last24h: 87 })).toBe(true)
    expect(validStats(null)).toBe(false)
    expect(validStats({ total: 0, last24h: 0 })).toBe(false)
    expect(validStats({ total: 10, last24h: 11 })).toBe(false)
    expect(validStats({ total: NaN, last24h: 1 })).toBe(false)
    expect(validStats({ total: '12', last24h: 1 })).toBe(false)
  })
})
