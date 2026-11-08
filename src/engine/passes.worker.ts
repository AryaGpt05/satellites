/// <reference lib="webworker" />
/**
 * Pass-search worker. Stateless: each message carries a chunk of targets (catalog rows + field rules)
 * and the query; the worker builds its own SGP4 records and returns the passes.
 */
import type { Pass } from '@/types'
import { findPasses, type PassQuery, type PassTarget } from './passes'

export interface WorkerRequest {
  type: 'run'
  chunkId: number
  targets: PassTarget[]
  query: PassQuery
}

export type WorkerResponse =
  | { type: 'progress'; chunkId: number; done: number }
  | { type: 'result'; chunkId: number; passes: Pass[]; ms: number }
  | { type: 'error'; chunkId: number; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  if (msg?.type !== 'run') return
  const start = performance.now()
  try {
    let last = 0
    const passes = findPasses(msg.targets, msg.query, (done) => {
      // Throttle: at most one progress message per ~4 satellites.
      if (done - last >= 4) {
        ctx.postMessage({ type: 'progress', chunkId: msg.chunkId, done } satisfies WorkerResponse)
        last = done
      }
    })
    ctx.postMessage({ type: 'result', chunkId: msg.chunkId, passes, ms: performance.now() - start } satisfies WorkerResponse)
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      chunkId: msg.chunkId,
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse)
  }
}
