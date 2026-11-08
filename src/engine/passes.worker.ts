/// <reference lib="webworker" />
/**
 * Pass-search worker. Stateless: each message carries a chunk of targets (catalog rows + field rules)
 * and the query; the worker builds its own SGP4 records and returns the passes.
 */
import { findPasses, type PassQuery, type PassTarget } from './passes'
import { packTracks, type BarePass, type PackedTracks } from './tracks'

export interface WorkerRequest {
  type: 'run'
  chunkId: number
  targets: PassTarget[]
  query: PassQuery
}

export type WorkerResponse =
  | { type: 'progress'; chunkId: number; done: number }
  /** Passes without their tracks, plus all the chunk's tracks in one transferable buffer (see tracks.ts) */
  | { type: 'result'; chunkId: number; passes: BarePass[]; tracks: PackedTracks; ms: number }
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
    const packed = packTracks(passes)
    ctx.postMessage(
      { type: 'result', chunkId: msg.chunkId, passes: packed.passes, tracks: packed.tracks, ms: performance.now() - start } satisfies WorkerResponse,
      [packed.tracks.points.buffer as ArrayBuffer, packed.tracks.spans.buffer as ArrayBuffer],
    )
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      chunkId: msg.chunkId,
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse)
  }
}
