import { describe, expect, it } from 'vitest'
import { useApp } from '@/state/store'
import { provisionalTier } from './quality'
import { createRuntime } from './runtime'
import { canUpload, firstDayStep, stripCount, upgradePlan } from './textures'

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

describe('canUpload (decision 9, R2G1, R2G4)', () => {
  const base = () => {
    const rt = createRuntime(provisionalTier(false), false, Date.now())
    rt.camera.arrivedAt = 0
    rt.phaseEnteredAt = 0
    return rt
  }
  const setStore = (p: Partial<ReturnType<typeof useApp.getState>>) =>
    useApp.setState({ phase: 'idle', timeMode: 'live', motionBusyUntil: 0, ...p })

  it('boot: allowed (the curtain covers the globe)', () => {
    setStore({ phase: 'boot' })
    const rt = base()
    rt.camera.arrivedAt = 9_999
    expect(canUpload(rt, 10_000)).toBe(true)
  })
  it('computing: only at the very start of the flight or once parked for 300 ms', () => {
    setStore({ phase: 'computing' })
    const rt = base()
    rt.phaseEnteredAt = 9_900
    rt.camera.flying = true
    rt.camera.progress = 0.02
    expect(canUpload(rt, 10_000)).toBe(true)
    rt.camera.progress = 0.04
    expect(canUpload(rt, 10_000)).toBe(false)
    rt.camera.progress = 0.9
    expect(canUpload(rt, 10_000)).toBe(false)
    rt.camera.flying = false
    rt.camera.progress = 1
    rt.camera.arrivedAt = 9_800
    expect(canUpload(rt, 10_000)).toBe(false)
    rt.camera.arrivedAt = 9_650
    expect(canUpload(rt, 10_000)).toBe(true)
  })
  it('computing: a hold inherited from the landing does not block; a new one does', () => {
    setStore({ phase: 'computing', motionBusyUntil: 11_000 })
    const rt = base()
    rt.phaseBusyFloor = 11_000
    expect(canUpload(rt, 10_000)).toBe(true)
    useApp.setState({ motionBusyUntil: 11_500 })
    expect(canUpload(rt, 10_000)).toBe(false)
  })
  it('elsewhere: no flight, 600 ms after arrival, 2 s into the phase, past UI holds', () => {
    setStore({ phase: 'results' })
    const rt = base()
    expect(canUpload(rt, 10_000)).toBe(true)
    rt.camera.arrivedAt = 9_500
    expect(canUpload(rt, 10_000)).toBe(false)
    rt.camera.arrivedAt = 0
    rt.phaseEnteredAt = 8_500
    expect(canUpload(rt, 10_000)).toBe(false)
    rt.phaseEnteredAt = 0
    useApp.setState({ motionBusyUntil: 10_100 })
    expect(canUpload(rt, 10_000)).toBe(false)
  })
  it('replay: nothing during the first 10 s of the sweep', () => {
    setStore({ phase: 'results', timeMode: 'replay' })
    const rt = base()
    rt.replayStartedAt = 5_000
    expect(canUpload(rt, 10_000)).toBe(false)
    expect(canUpload(rt, 15_001)).toBe(true)
  })
})

describe('first day step (the regional zoom floor)', () => {
  it('is day 2k on phones and day 4k on desktops', () => {
    expect(firstDayStep(upgradePlan({ ...provisionalTier(true), allow4k: true }))).toEqual({ map: 'day', res: '2k', when: 'idle' })
    expect(firstDayStep(upgradePlan({ ...provisionalTier(false), allow4k: true, allow8k: true }))).toEqual({ map: 'day', res: '4k', when: 'idle' })
  })
})
