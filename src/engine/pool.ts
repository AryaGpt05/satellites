/**
 * Worker pool for pass search.
 *
 * - Size: hardwareConcurrency − 1, clamped to [1, 6]. Created lazily, kept warm between reports.
 * - Work is split into small chunks of satellites and handed out dynamically, so a slow chunk never
 *   leaves the other workers idle, and progress streams at chunk granularity.
 * - Several jobs may share the pool; aborting a job drops its queued chunks (in-flight chunks are
 *   tiny and their results are discarded).
 * - Resilience: if workers are unavailable (no Worker global, blocked by CSP, module failed to load),
 *   chunks run on the main thread, yielding to the event loop between chunks.
 */
import type { Pass } from '@/types'
import { findPasses, type PassQuery, type PassTarget } from './passes'
import type { WorkerRequest, WorkerResponse } from './passes.worker'

const CHUNK_SIZE = 12

interface Job {
  query: PassQuery
  total: number
  /** satellites finished per chunk (completed or partial) */
  progress: Map<number, number>
  pendingChunks: number
  passes: Pass[]
  aborted: boolean
  onProgress?: (done: number, total: number) => void
  resolve: (p: Pass[]) => void
  reject: (e: unknown) => void
}

interface Chunk {
  id: number
  job: Job
  targets: PassTarget[]
}

interface Slot {
  worker: Worker
  chunk?: Chunk
  dead: boolean
}

let nextChunkId = 1

function abortError(): Error {
  return typeof DOMException !== 'undefined' ? new DOMException('Aborted', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' })
}

export function poolSize(): number {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
  return Math.min(6, Math.max(1, hc - 1))
}

class PassPool {
  private slots: Slot[] = []
  private queue: Chunk[] = []
  private mainThreadBusy = false
  private chunks = new Map<number, Chunk>()

  constructor(size: number) {
    if (typeof Worker === 'undefined') return
    for (let i = 0; i < size; i++) {
      try {
        const worker = new Worker(new URL('./passes.worker.ts', import.meta.url), { type: 'module', name: `passes-${i}` })
        const slot: Slot = { worker, dead: false }
        worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(slot, ev.data)
        worker.onerror = (ev) => {
          ev.preventDefault?.()
          this.onWorkerFailure(slot)
        }
        worker.onmessageerror = () => this.onWorkerFailure(slot)
        this.slots.push(slot)
      } catch {
        break // CSP or unsupported module workers: fall back to the main thread
      }
    }
  }

  get workerCount(): number {
    return this.slots.filter((s) => !s.dead).length
  }

  run(targets: PassTarget[], query: PassQuery, onProgress?: Job['onProgress'], signal?: AbortSignal): Promise<Pass[]> {
    return new Promise<Pass[]>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const job: Job = { query, total: targets.length, progress: new Map(), pendingChunks: 0, passes: [], aborted: false, onProgress, resolve, reject }
      if (!targets.length) return resolve([])
      for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
        const chunk: Chunk = { id: nextChunkId++, job, targets: targets.slice(i, i + CHUNK_SIZE) }
        job.pendingChunks++
        this.chunks.set(chunk.id, chunk)
        this.queue.push(chunk)
      }
      signal?.addEventListener(
        'abort',
        () => {
          if (job.aborted || job.pendingChunks === 0) return
          job.aborted = true
          this.queue = this.queue.filter((c) => c.job !== job)
          reject(abortError())
        },
        { once: true },
      )
      this.pump()
    })
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.dead || slot.chunk) continue
      const chunk = this.queue.shift()
      if (!chunk) return
      slot.chunk = chunk
      const req: WorkerRequest = { type: 'run', chunkId: chunk.id, targets: chunk.targets, query: chunk.job.query }
      slot.worker.postMessage(req)
    }
    if (this.queue.length && this.workerCount === 0) void this.drainOnMainThread()
  }

  private onMessage(slot: Slot, msg: WorkerResponse) {
    const chunk = this.chunks.get(msg.chunkId)
    if (!chunk) return
    if (msg.type === 'progress') {
      this.report(chunk, msg.done)
      return
    }
    slot.chunk = undefined
    if (msg.type === 'result') this.complete(chunk, msg.passes)
    else this.complete(chunk, findPasses(chunk.targets, chunk.job.query)) // worker threw: redo here
    this.pump()
  }

  private onWorkerFailure(slot: Slot) {
    if (slot.dead) return
    slot.dead = true
    try {
      slot.worker.terminate()
    } catch {
      /* already gone */
    }
    if (slot.chunk) {
      this.queue.unshift(slot.chunk)
      slot.chunk = undefined
    }
    this.pump()
  }

  /** Fallback: process queued chunks on the main thread, one per macrotask. */
  private async drainOnMainThread() {
    if (this.mainThreadBusy) return
    this.mainThreadBusy = true
    try {
      while (this.queue.length) {
        const chunk = this.queue.shift()!
        if (chunk.job.aborted) continue
        const passes = findPasses(chunk.targets, chunk.job.query, (done) => this.report(chunk, done))
        this.complete(chunk, passes)
        await new Promise((r) => setTimeout(r, 0))
      }
    } finally {
      this.mainThreadBusy = false
    }
  }

  private report(chunk: Chunk, done: number) {
    const job = chunk.job
    if (job.aborted) return
    job.progress.set(chunk.id, done)
    let sum = 0
    for (const v of job.progress.values()) sum += v
    job.onProgress?.(Math.min(sum, job.total), job.total)
  }

  private complete(chunk: Chunk, passes: Pass[]) {
    this.chunks.delete(chunk.id)
    const job = chunk.job
    if (job.aborted) return
    for (const p of passes) job.passes.push(p)
    this.report(chunk, chunk.targets.length)
    if (--job.pendingChunks === 0) job.resolve(job.passes)
  }
}

let pool: PassPool | undefined

/** Create the workers ahead of time (e.g. at boot) so the first report doesn't pay their start-up. */
export function warmPassWorkers(): void {
  pool ??= new PassPool(poolSize())
}

/** Search all targets, in workers when available. Resolves with passes in arbitrary order. */
export function runPassSearch(
  targets: PassTarget[],
  query: PassQuery,
  opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<Pass[]> {
  warmPassWorkers()
  return pool!.run(targets, query, opts.onProgress, opts.signal)
}

/** Number of live workers (0 = main-thread fallback). */
export function passWorkerCount(): number {
  return pool?.workerCount ?? 0
}
