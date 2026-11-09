/**
 * Worker pool for pass search.
 *
 * - Size: hardwareConcurrency − 1, clamped to [1, 4] on desktop and [1, 2] on phones (a week's search is
 *   ~400 satellites and ~0.5 s: more workers only add start-up and memory). Created lazily (the app warms
 *   them in idle time after the landing's entrance), kept warm between reports.
 * - One script for all of them (G-M2): in a build the worker is one self-contained module, fetched once and
 *   shared through a blob: URL. N workers constructed from its URL at once each fetch it (none hits the HTTP
 *   cache yet; a revalidating server answers every one). Chunks queue while the script loads; they never fall
 *   back to the main thread just because the workers are still starting.
 * - Results come back with their ground tracks packed in one transferable buffer per chunk (tracks.ts),
 *   materialised lazily, so receiving a chunk costs the main thread almost nothing.
 * - Work is split into small chunks of satellites and handed out dynamically (FIFO across jobs), so a
 *   slow chunk never leaves the other workers idle, and progress streams at chunk granularity. A job
 *   submitted first is served first: the report submits its most urgent satellites as their own job.
 * - Several jobs may share the pool; aborting a job drops its queued chunks (in-flight chunks are
 *   small and their results are discarded).
 * - Resilience: if workers are unavailable (no Worker global, blocked by CSP, module failed to load),
 *   chunks run on the main thread, yielding to the event loop between chunks. A chunk that fails
 *   even there rejects its job instead of leaving it pending forever.
 */
import type { Pass } from '@/types'
import { findPasses, type PassQuery, type PassTarget } from './passes'
import type { WorkerRequest, WorkerResponse } from './passes.worker'
import passesWorkerUrl from './passes.worker.ts?worker&url'
import { unpackTracks } from './tracks'

/** Default satellites per chunk: large enough to amortise messaging, small enough to balance load. */
const CHUNK_SIZE = 12

interface Job {
  query: PassQuery
  total: number
  /** satellites finished per chunk (completed or partial) */
  progress: Map<number, number>
  pendingChunks: number
  passes: Pass[]
  /** Set once the job resolved, rejected or was aborted: later chunk results are ignored. */
  settled: boolean
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
  /** Started from the shared blob: URL, and whether it has answered since (it loaded). */
  script: { url: string; shared: boolean }
  alive?: boolean
}

export interface PassSearchOptions {
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  /** Satellites per chunk (default 12). Use 1 to spread a few urgent satellites over every worker. */
  chunkSize?: number
}

let nextChunkId = 1

function abortError(): Error {
  return typeof DOMException !== 'undefined' ? new DOMException('Aborted', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' })
}

/** Phone-class device: a coarse primary pointer (no hover). */
function isMobileTier(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse) and (hover: none)').matches
}

export function poolSize(): number {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
  return Math.min(isMobileTier() ? 2 : 4, Math.max(1, hc - 1))
}

/**
 * The script every pass worker runs: in a build, the bundle fetched once and shared as a blob: URL (G-M2); in dev
 * (an unbundled module with imports, which a blob: URL can't resolve) and when the fetch fails, its own URL.
 */
function workerScript(): Promise<{ url: string; shared: boolean }> {
  const own = { url: passesWorkerUrl, shared: false }
  if (!import.meta.env.PROD || typeof fetch !== 'function' || typeof URL.createObjectURL !== 'function') return Promise.resolve(own)
  return fetch(passesWorkerUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.blob()
    })
    .then((b) => ({ url: URL.createObjectURL(new Blob([b], { type: 'text/javascript' })), shared: true }))
    .catch(() => own)
}

class PassPool {
  private slots: Slot[] = []
  private queue: Chunk[] = []
  private mainThreadBusy = false
  private chunks = new Map<number, Chunk>()
  /** The worker script is loading: queued chunks wait for the workers instead of running here. */
  private starting = false

  constructor(private size: number) {
    if (typeof Worker === 'undefined') return
    this.starting = true
    void workerScript().then((script) => this.spawn(script))
  }

  private spawn(script: { url: string; shared: boolean }) {
    for (let i = 0; i < this.size; i++) {
      try {
        const worker = new Worker(script.url, { type: 'module', name: `passes-${i}` })
        const slot: Slot = { worker, dead: false, script }
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
    this.starting = false
    this.pump()
  }

  get workerCount(): number {
    return this.slots.filter((s) => !s.dead).length
  }

  run(targets: PassTarget[], query: PassQuery, opts: PassSearchOptions = {}): Promise<Pass[]> {
    const { signal, onProgress } = opts
    const size = Math.max(1, Math.floor(opts.chunkSize ?? CHUNK_SIZE))
    return new Promise<Pass[]>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      if (!targets.length) return resolve([])
      const onAbort = () => {
        if (job.settled) return
        job.settled = true
        this.dropSettled()
        reject(abortError())
      }
      // The listener is removed as soon as the job settles, so a long-lived signal doesn't keep
      // a finished job's passes alive.
      const done = () => signal?.removeEventListener('abort', onAbort)
      const job: Job = {
        query,
        total: targets.length,
        progress: new Map(),
        pendingChunks: 0,
        passes: [],
        settled: false,
        onProgress,
        resolve: (p) => (done(), resolve(p)),
        reject: (e) => (done(), reject(e)),
      }
      for (let i = 0; i < targets.length; i += size) {
        const chunk: Chunk = { id: nextChunkId++, job, targets: targets.slice(i, i + size) }
        job.pendingChunks++
        this.chunks.set(chunk.id, chunk)
        this.queue.push(chunk)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pump()
    })
  }

  /** Forget queued chunks whose job already settled (aborted or failed). */
  private dropSettled() {
    const live: Chunk[] = []
    for (const c of this.queue) {
      if (c.job.settled) this.chunks.delete(c.id)
      else live.push(c)
    }
    this.queue = live
  }

  private pump() {
    this.dropSettled()
    for (const slot of this.slots) {
      if (slot.dead || slot.chunk) continue
      const chunk = this.queue.shift()
      if (!chunk) return
      slot.chunk = chunk
      const req: WorkerRequest = { type: 'run', chunkId: chunk.id, targets: chunk.targets, query: chunk.job.query }
      slot.worker.postMessage(req)
    }
    if (this.queue.length && this.workerCount === 0 && !this.starting) void this.drainOnMainThread()
  }

  private onMessage(slot: Slot, msg: WorkerResponse) {
    slot.alive = true
    if (msg.type === 'ready') return
    const chunk = this.chunks.get(msg.chunkId)
    if (!chunk) return
    if (msg.type === 'progress') {
      this.report(chunk, msg.done)
      return
    }
    slot.chunk = undefined
    if (msg.type === 'result') this.complete(chunk, unpackTracks(msg.passes, msg.tracks))
    else this.runHere(chunk) // the worker threw: retry once on the main thread
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
    // Every worker started from the shared blob: URL failed before it ever answered (an engine without module
    // workers from blob: URLs): start them once more from the script's own URL.
    if (this.slots.every((s) => s.dead && s.script.shared && !s.alive) && this.slots.length === this.size) {
      this.slots = []
      this.spawn({ url: passesWorkerUrl, shared: false })
      return
    }
    this.pump()
  }

  /** Run one chunk synchronously on this thread; a failure rejects the chunk's job. */
  private runHere(chunk: Chunk) {
    if (chunk.job.settled) {
      this.chunks.delete(chunk.id)
      return
    }
    try {
      this.complete(chunk, findPasses(chunk.targets, chunk.job.query, (done) => this.report(chunk, done)))
    } catch (err) {
      this.fail(chunk, err)
    }
  }

  /** Fallback: process queued chunks on the main thread, one per macrotask. */
  private async drainOnMainThread() {
    if (this.mainThreadBusy) return
    this.mainThreadBusy = true
    try {
      while (this.queue.length) {
        this.runHere(this.queue.shift()!)
        await new Promise((r) => setTimeout(r, 0))
      }
    } finally {
      this.mainThreadBusy = false
    }
  }

  private report(chunk: Chunk, done: number) {
    const job = chunk.job
    if (job.settled) return
    job.progress.set(chunk.id, done)
    let sum = 0
    for (const v of job.progress.values()) sum += v
    try {
      job.onProgress?.(Math.min(sum, job.total), job.total)
    } catch (err) {
      // A throwing progress callback must never stop a chunk from completing (the job would hang).
      console.error('Pass search progress callback threw:', err)
    }
  }

  private complete(chunk: Chunk, passes: Pass[]) {
    this.chunks.delete(chunk.id)
    const job = chunk.job
    if (job.settled) return
    for (const p of passes) job.passes.push(p)
    this.report(chunk, chunk.targets.length)
    if (--job.pendingChunks === 0) {
      job.settled = true
      job.resolve(job.passes)
    }
  }

  private fail(chunk: Chunk, err: unknown) {
    this.chunks.delete(chunk.id)
    const job = chunk.job
    if (job.settled) return
    job.settled = true
    job.reject(err)
  }
}

let pool: PassPool | undefined

/** Create the workers ahead of time (e.g. at boot) so the first report doesn't pay their start-up. */
export function warmPassWorkers(): void {
  pool ??= new PassPool(poolSize())
}

/** Search all targets, in workers when available. Resolves with passes in arbitrary order. */
export function runPassSearch(targets: PassTarget[], query: PassQuery, opts: PassSearchOptions = {}): Promise<Pass[]> {
  warmPassWorkers()
  return pool!.run(targets, query, opts)
}

/** Number of live workers (0 = main-thread fallback). */
export function passWorkerCount(): number {
  return pool?.workerCount ?? 0
}
