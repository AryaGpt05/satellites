/** Small promise helpers for the controller's sequencing (pure; unit-tested in src/app/app.test.ts). */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * `p`'s value, or null once `ms` has passed (never rejects). `ms` ≤ 0 still goes through a 0 ms timer, so an
 * already-settled `p` wins: its reaction is a microtask, which runs before any timer (R2K1: a share link that
 * resolved while a slow boot was still loading the globe must open, not time out at "0 ms left").
 */
export function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms))
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

/**
 * R-M1: is `r` the report the first results paint wants? The final one (not the partial), no longer waiting on a
 * clear cover, unless the cover won't lead (a share or pass link opens on its pass's own photo).
 */
export function isSettled(r: { partial?: boolean; coverPending?: boolean }, coverIrrelevant = false): boolean {
  return !r.partial && (coverIrrelevant || !r.coverPending)
}

/** The final report is built this long after the engine's GIBS budget ends, at most (matching, the build). */
export const FINAL_SLACK_MS = 150

/**
 * How long (from `now`) the first paint waits for the settled report: `race`, stretched by at most `grace` when
 * the engine says the final report is due just after that (`dueAt`, a partial report's finalDueAt).
 */
export function settleWaitMs(now: number, race: number, grace: number, dueAt?: number): number {
  if (dueAt === undefined) return race
  const until = dueAt + FINAL_SLACK_MS - now
  return until <= race + grace ? Math.max(race, until) : race
}
