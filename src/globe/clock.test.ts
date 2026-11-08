import { describe, expect, it } from 'vitest'
import { CLOCK_WRITE_INTERVAL_MS, createClock, MAX_FRAME_DT_S, stepClock, type ClockInput } from './clock'

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0)

function run(frames: Partial<ClockInput>[], start = createClock(T0, 'live', T0)) {
  let now = T0
  const writes: number[] = []
  let s = start
  for (const f of frames) {
    now += 16
    const r = stepClock(s, { mode: 'live', storeSimTime: T0, replayRate: 60, dt: 0.016, now, ...f })
    s = r.state
    if (r.write !== undefined) writes.push(r.write)
  }
  return { s, writes }
}

describe('stepClock', () => {
  it('follows the wall clock in live mode and writes at most every interval', () => {
    let now = T0
    let s = createClock(T0, 'live', T0)
    let writes = 0
    for (let i = 0; i < 60; i++) {
      now += 16
      const r = stepClock(s, { mode: 'live', storeSimTime: s.lastWritten, replayRate: 60, dt: 0.016, now })
      s = r.state
      expect(s.simTime).toBe(now)
      if (r.write !== undefined) writes++
    }
    // 60 frames × 16 ms ≈ 960 ms → about 10 writes
    expect(writes).toBeGreaterThanOrEqual(9)
    expect(writes).toBeLessThanOrEqual(Math.ceil(960 / CLOCK_WRITE_INTERVAL_MS) + 1)
  })

  it('advances by replayRate × dt in replay, seeded from the store', () => {
    const seed = T0 - 3_600_000
    const s = createClock(T0, 'live', T0)
    const r = stepClock(s, { mode: 'replay', storeSimTime: seed, replayRate: 60, dt: 0.016, now: T0 + 16 })
    expect(r.state.simTime).toBeCloseTo(seed + 60 * 16, 6)
  })

  it('adopts a seek made by the UI during replay', () => {
    const s = createClock(T0, 'replay', T0)
    s.lastWritten = T0
    const target = T0 + 42_000
    const r = stepClock(s, { mode: 'replay', storeSimTime: target, replayRate: 1, dt: 0.01, now: T0 + 10 })
    expect(r.state.simTime).toBeCloseTo(target + 10, 6)
  })

  it('clamps huge frame deltas (background tab) in replay', () => {
    const s = createClock(T0, 'replay', T0)
    s.lastWritten = T0
    const r = stepClock(s, { mode: 'replay', storeSimTime: T0, replayRate: 100, dt: 30, now: T0 + 30_000 })
    expect(r.state.simTime).toBeCloseTo(T0 + 100 * MAX_FRAME_DT_S * 1000, 6)
  })

  it('holds the exact frame when replay is paused (flushes once)', () => {
    const s = createClock(T0, 'replay', T0)
    s.lastWritten = T0
    s.lastWriteAt = T0
    // advance a few frames without hitting the throttle
    let now = T0
    for (let i = 0; i < 3; i++) {
      now += 16
      stepClock(s, { mode: 'replay', storeSimTime: s.lastWritten, replayRate: 60, dt: 0.016, now })
    }
    const shown = s.simTime
    const r = stepClock(s, { mode: 'scrub', storeSimTime: s.lastWritten, replayRate: 60, dt: 0.016, now: now + 16 })
    expect(r.write).toBe(shown)
    expect(r.state.simTime).toBe(shown)
    // next frame: store now holds the flushed value, scrub follows it
    const r2 = stepClock(s, { mode: 'scrub', storeSimTime: shown, replayRate: 60, dt: 0.016, now: now + 32 })
    expect(r2.state.simTime).toBe(shown)
    expect(r2.write).toBeUndefined()
  })

  it('follows the store exactly in scrub mode and never writes', () => {
    const { s, writes } = run([
      { mode: 'scrub', storeSimTime: T0 + 1000 },
      { mode: 'scrub', storeSimTime: T0 + 5000 },
      { mode: 'scrub', storeSimTime: T0 - 9000 },
    ])
    expect(s.simTime).toBe(T0 - 9000)
    expect(writes).toEqual([])
  })

  it('does not clobber a time the UI sets while live, just before switching to replay', () => {
    const s = createClock(T0, 'live', T0)
    s.lastWritten = T0
    s.lastWriteAt = T0 - 1000 // a write would be due
    const seed = T0 - 86_400_000
    const r1 = stepClock(s, { mode: 'live', storeSimTime: seed, replayRate: 60, dt: 0.016, now: T0 + 16 })
    expect(r1.write).toBeUndefined()
    const r2 = stepClock(s, { mode: 'replay', storeSimTime: seed, replayRate: 60, dt: 0.016, now: T0 + 32 })
    expect(r2.state.simTime).toBeCloseTo(seed + 60 * 16, 6)
  })
})
