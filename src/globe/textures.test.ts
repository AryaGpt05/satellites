import { describe, expect, it } from 'vitest'
import { provisionalTier } from './quality'
import { stripCount, upgradePlan } from './textures'

describe('upgradePlan (decision 9)', () => {
  it('phones go 1k → 2k at landing idle, day 4k only after a place, never clouds-4k or data-4k', () => {
    const plan = upgradePlan({ ...provisionalTier(true), allow4k: true, allow8k: false })
    expect(plan.filter((s) => s.when === 'idle').map((s) => `${s.map}-${s.res}`)).toEqual(['day-2k', 'night-2k', 'clouds-2k'])
    expect(plan.find((s) => s.res === '4k')).toEqual({ map: 'day', res: '4k', when: 'place' })
    expect(plan.some((s) => s.map === 'clouds' && s.res === '4k')).toBe(false)
    expect(plan.some((s) => s.map === 'data')).toBe(false)
  })
  it('desktops get the 4k set at landing idle and 8k only after results', () => {
    const plan = upgradePlan({ ...provisionalTier(false), allow4k: true, allow8k: true })
    expect(plan.filter((s) => s.when === 'idle').map((s) => `${s.map}-${s.res}`)).toEqual(['day-4k', 'night-4k', 'clouds-4k', 'data-4k'])
    expect(plan.at(-1)).toEqual({ map: 'day', res: '8k', when: 'results' })
  })
  it('slices uploads into 256-row strips', () => {
    expect(stripCount('2k')).toBe(4)
    expect(stripCount('4k')).toBe(8)
    expect(stripCount('8k')).toBe(16)
  })
})
