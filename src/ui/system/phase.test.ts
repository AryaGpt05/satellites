import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncToWallSecond } from './phase'

/** A stand-in for Element.getAnimations() results: just the parts syncToWallSecond reads and writes. */
function anim(currentTime: number, timing: { duration: number; iterations: number; delay?: number }) {
  return { currentTime, effect: { getTiming: () => ({ delay: 0, ...timing }) } }
}
function el(anims: ReturnType<typeof anim>[]) {
  return { getAnimations: () => anims } as unknown as Element
}

describe('syncToWallSecond', () => {
  afterEach(() => vi.useRealTimers())

  it('puts a 1 s infinite blink in phase with the wall-clock second', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 10, 8, 4, 0, 0, 250)) // 250 ms into the second
    const blink = anim(5_870, { duration: 1000, iterations: Infinity })
    syncToWallSecond(el([blink]))
    expect(blink.currentTime % 1000).toBe(250)
  })

  it('accounts for an animation delay', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 10, 8, 4, 0, 0, 600))
    const blink = anim(3_000, { duration: 1000, iterations: Infinity, delay: 120 })
    syncToWallSecond(el([blink]))
    expect((blink.currentTime - 120) % 1000).toBe(600)
  })

  it('leaves animations already in phase, and anything that is not a 1 s infinite loop, alone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 10, 8, 4, 0, 0, 400))
    const inPhase = anim(7_410, { duration: 1000, iterations: Infinity })
    const entrance = anim(90, { duration: 240, iterations: 1 })
    const slow = anim(90, { duration: 2000, iterations: Infinity })
    syncToWallSecond(el([inPhase, entrance, slow]))
    expect(inPhase.currentTime).toBe(7_410)
    expect(entrance.currentTime).toBe(90)
    expect(slow.currentTime).toBe(90)
  })

  it('tolerates missing elements and environments without getAnimations', () => {
    expect(() => syncToWallSecond(null)).not.toThrow()
    expect(() => syncToWallSecond({} as Element)).not.toThrow()
  })
})
