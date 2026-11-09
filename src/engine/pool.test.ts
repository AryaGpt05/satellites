/**
 * Worker-pool lifecycle with a fake Worker (vitest runs in node, which has none): healthy workers,
 * workers that fail to load, workers that throw, deterministic failures, abort, and FIFO priority.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Pass } from '@/types'
import { getRow } from './catalog'
import { findPasses, passTargetFor, type PassQuery, type PassTarget } from './passes'
import type { WorkerRequest, WorkerResponse } from './passes.worker'
import { packTracks } from './tracks'
import { loadTestCatalog, WATERLOO } from './testing'

type Mode = 'ok' | 'fail-load' | 'error-reply'

/** Minimal stand-in for a module Worker that runs the real pass search asynchronously. */
class FakeWorker {
  static mode: Mode = 'ok'
  static instances: FakeWorker[] = []
  static served: number[][] = []
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((ev: { preventDefault(): void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false
  constructor() {
    FakeWorker.instances.push(this)
    if (FakeWorker.mode === 'fail-load') setTimeout(() => this.onerror?.({ preventDefault() {} }), 1)
  }
  postMessage(req: WorkerRequest) {
    FakeWorker.served.push(req.targets.map((t) => t.norad))
    setTimeout(() => {
      if (this.terminated || FakeWorker.mode === 'fail-load') return
      const reply: WorkerResponse =
        FakeWorker.mode === 'error-reply'
          ? { type: 'error', chunkId: req.chunkId, message: 'boom' }
          : { type: 'result', chunkId: req.chunkId, ...packTracks(findPasses(req.targets, req.query)), ms: 0 }
      this.onmessage?.({ data: reply } as MessageEvent<WorkerResponse>)
    }, 1)
  }
  terminate() {
    this.terminated = true
  }
}

let targets: PassTarget[]
let query: PassQuery
let reference: number

beforeAll(() => {
  const cat = loadTestCatalog()
  const t1 = Date.parse(cat.fetchedAt)
  query = { place: WATERLOO, t0: t1 - 86_400_000, t1 }
  targets = cat.sats
    .filter((s) => s.category !== 'other')
    .map((s) => passTargetFor(s, getRow(s.norad)!))
    .filter((t): t is PassTarget => !!t)
    .slice(0, 40)
  reference = findPasses(targets, query).length
})

/** A fresh pool module (it is a singleton) running against the fake Worker in `mode`. */
async function freshPool(mode: Mode) {
  vi.resetModules()
  FakeWorker.mode = mode
  FakeWorker.instances = []
  FakeWorker.served = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('navigator', { hardwareConcurrency: 4 })
  return import('./pool')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const ids = (passes: Pass[]) => passes.map((p) => p.id).sort()

describe('pass worker pool', () => {
  it('spreads chunks over hardwareConcurrency − 1 workers and returns every pass', async () => {
    const pool = await freshPool('ok')
    const progress: number[] = []
    const passes = await pool.runPassSearch(targets, query, { onProgress: (n) => progress.push(n) })
    expect(pool.passWorkerCount()).toBe(3)
    expect(passes.length).toBe(reference)
    expect(progress[progress.length - 1]).toBe(targets.length)
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1])
  })

  it('caps phones at two workers, desktops at four (G-M2)', async () => {
    const pool = await freshPool('ok')
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 })
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: /coarse/.test(q) }))
    expect(pool.poolSize()).toBe(2)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    expect(pool.poolSize()).toBe(4)
  })

  it('queues work while the workers start, instead of running it on the main thread', async () => {
    const pool = await freshPool('ok')
    const p = pool.runPassSearch(targets, query)
    // Nothing ran here synchronously: every chunk went to a worker.
    const passes = await p
    expect(passes.length).toBe(reference)
    expect(FakeWorker.served.flat().length).toBe(targets.length)
  })

  it('falls back to the main thread when the worker module fails to load', async () => {
    const pool = await freshPool('fail-load')
    const passes = await pool.runPassSearch(targets, query)
    expect(passes.length).toBe(reference)
    expect(pool.passWorkerCount()).toBe(0)
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true)
  })

  it('redoes a chunk on the main thread when the worker reports an error', async () => {
    const pool = await freshPool('error-reply')
    const passes = await pool.runPassSearch(targets, query)
    expect(ids(passes)).toEqual(ids(findPasses(targets, query)))
  })

  it('rejects (instead of hanging) when a chunk fails on the main thread too', async () => {
    vi.doMock('./passes', async (orig) => ({
      ...(await orig<typeof import('./passes')>()),
      findPasses: () => {
        throw new Error('boom')
      },
    }))
    try {
      const pool = await freshPool('error-reply')
      await expect(pool.runPassSearch(targets, query)).rejects.toThrow('boom')
    } finally {
      vi.doUnmock('./passes')
    }
  })

  it('completes even if the progress callback throws', async () => {
    const pool = await freshPool('ok')
    const err = console.error
    console.error = () => undefined
    try {
      const passes = await pool.runPassSearch(targets, query, {
        onProgress: () => {
          throw new Error('ui bug')
        },
      })
      expect(passes.length).toBe(reference)
    } finally {
      console.error = err
    }
  })

  it('aborts: rejects with AbortError, drops queued chunks and detaches from the signal', async () => {
    const pool = await freshPool('ok')
    const ctl = new AbortController()
    const add = vi.spyOn(ctl.signal, 'addEventListener')
    const p = pool.runPassSearch(targets, query, { signal: ctl.signal })
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    const servedAtAbort = FakeWorker.served.length
    await new Promise((r) => setTimeout(r, 30))
    expect(FakeWorker.served.length).toBe(servedAtAbort) // nothing new was dispatched
    expect(servedAtAbort).toBeLessThanOrEqual(3) // only the chunks already in flight

    // A job that completes normally removes its abort listener.
    const ctl2 = new AbortController()
    const add2 = vi.spyOn(ctl2.signal, 'addEventListener')
    const remove2 = vi.spyOn(ctl2.signal, 'removeEventListener')
    await pool.runPassSearch(targets.slice(0, 5), query, { signal: ctl2.signal })
    expect(add2).toHaveBeenCalledTimes(1)
    expect(remove2).toHaveBeenCalledTimes(1)
    // The aborted job's listener was registered { once: true }, so firing removed it.
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
  })

  it('serves the first job first, one satellite per chunk when asked', async () => {
    const pool = await freshPool('ok')
    const urgent = targets.slice(0, 5)
    const rest = targets.slice(5)
    const a = pool.runPassSearch(urgent, query, { chunkSize: 1 })
    const b = pool.runPassSearch(rest, query)
    await Promise.all([a, b])
    // The first five dispatches are the urgent satellites, one each.
    expect(FakeWorker.served.slice(0, 5)).toEqual(urgent.map((t) => [t.norad]))
  })
})

describe('packed tracks', () => {
  it('round-trips tracks through the transferable buffer, lazily and exactly enough', async () => {
    const { packTracks, unpackTracks, clonePass } = await import('./tracks')
    const passes = findPasses(targets.slice(0, 10), query)
    expect(passes.length).toBeGreaterThan(0)
    const { passes: bare, tracks } = packTracks(passes)
    expect(bare.every((p) => !('track' in p))).toBe(true)
    const back = unpackTracks(bare, tracks)
    // Not decoded until read; a clone stays lazy and shares the decoded array.
    const copy = clonePass(back[0])
    expect(Object.getOwnPropertyDescriptor(copy, 'track')?.get).toBeTypeOf('function')
    back.forEach((p, i) => {
      const ref = passes[i]
      expect(p.track).toHaveLength(ref.track.length)
      p.track.forEach((q, k) => {
        expect(q.t).toBe(ref.track[k].t)
        expect(q.lat).toBeCloseTo(ref.track[k].lat, 4)
        expect(q.lon).toBeCloseTo(ref.track[k].lon, 4)
        expect(q.altKm).toBeCloseTo(ref.track[k].altKm, 2)
      })
      expect({ ...p, track: undefined }).toEqual({ ...ref, track: undefined })
    })
    expect(copy.track).toBe(back[0].track)
    // Assigning replaces the accessor with a plain value.
    back[1].track = []
    expect(back[1].track).toEqual([])
  })
})
