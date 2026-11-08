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
