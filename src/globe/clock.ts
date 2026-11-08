/**
 * The simulation clock as a pure state machine, so it can be unit-tested without a frame loop.
 *
 *  - live:   simTime follows the wall clock.
 *  - replay: simTime advances by replayRate × dt. If the store's simTime changes underneath us (the UI
 *            seeked), we adopt it.
 *  - scrub:  simTime follows the store exactly (the UI owns it).
 *
 * The globe owns the frame loop, so in live/replay it writes simTime back to the store, throttled, to keep
 * React re-renders down. When replay stops we flush the exact frame time once, so a pause holds the
 * frame that was on screen instead of jumping back to the last throttled write.
 */
export type TimeMode = 'live' | 'scrub' | 'replay'

export interface ClockState {
  simTime: number
  mode: TimeMode
  /** The last store value we wrote or acknowledged; a different store value means the UI moved time */
  lastWritten: number
  /** Wall-clock ms of the last store write */
  lastWriteAt: number
}

export interface ClockInput {
  mode: TimeMode
  storeSimTime: number
  replayRate: number
  /** Frame delta, seconds */
  dt: number
  /** Wall clock, epoch ms */
  now: number
}

/** Store writes at most this often (ms). */
export const CLOCK_WRITE_INTERVAL_MS = 100
/** A frame delta larger than this (tab was hidden, debugger) advances replay by this much at most. */
export const MAX_FRAME_DT_S = 0.1

export function createClock(storeSimTime: number, mode: TimeMode, now: number): ClockState {
  return { simTime: mode === 'live' ? now : storeSimTime, mode, lastWritten: storeSimTime, lastWriteAt: -Infinity }
}

/**
 * Advance the clock one frame. Mutates and returns `s`; `write` is the value to push to the store, if any.
 */
export function stepClock(s: ClockState, inp: ClockInput): { state: ClockState; write?: number } {
  const seeked = inp.storeSimTime !== s.lastWritten
  let write: number | undefined
  const prevMode = s.mode

  if (inp.mode !== prevMode) {
    s.mode = inp.mode
    if (inp.mode === 'replay') {
      // Replay starts from the store's time: the UI's seed, the paused frame, or our own last live write.
      s.simTime = inp.storeSimTime
    } else if (inp.mode === 'scrub' && prevMode === 'replay' && !seeked) {
      // Pause: hold the exact frame we were showing and tell the store.
      write = s.simTime
    } else if (inp.mode === 'scrub') {
      s.simTime = inp.storeSimTime
    }
  }

  switch (s.mode) {
    case 'live':
      s.simTime = inp.now
      if (seeked && inp.mode === prevMode) {
        // The UI wrote a time while we're live (typically just before switching to replay). Don't clobber
        // it on this frame: acknowledge it and resume throttled writes one interval later.
        s.lastWritten = inp.storeSimTime
        s.lastWriteAt = inp.now
        return { state: s }
      }
      break
    case 'replay': {
      if (inp.mode === prevMode && seeked) s.simTime = inp.storeSimTime
      const dt = Math.min(Math.max(inp.dt, 0), MAX_FRAME_DT_S)
      s.simTime += inp.replayRate * dt * 1000
      break
    }
    case 'scrub':
      if (write === undefined) s.simTime = inp.storeSimTime
      break
  }

  if (write === undefined && s.mode !== 'scrub' && inp.now - s.lastWriteAt >= CLOCK_WRITE_INTERVAL_MS) {
    write = s.simTime
  }
  if (write !== undefined) {
    s.lastWritten = write
    s.lastWriteAt = inp.now
  }
  return { state: s, write }
}
