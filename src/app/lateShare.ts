/**
 * A share lookup that outlived boot (controller.adoptLateShare).
 *  - pending: it may still open the share, until it answers or its window closes;
 *  - unresolved: the landing keeps ?s= in the address bar (a reload may still find the share, CR-4), even after a
 *    late null or a timeout, until the visitor starts a search of their own (or the share opens, which is one).
 * A landing the visitor comes back to after their own search is clean, and a late answer can't open the share unasked.
 */
export interface LateShareGate {
  /** The lookup outlived boot: pending until `untilMs` (a performance.now() time) at the latest. */
  start(untilMs: number): void
  /** The lookup answered: true if it may still open (it was pending, inside its window). Ends the pending state. */
  answered(): boolean
  /** A search started (the visitor's own, or the share opening): ends both. */
  cancel(): void
  pending(): boolean
  unresolved(): boolean
}

export function createLateShareGate(clock: () => number = () => performance.now()): LateShareGate {
  let until = -Infinity
  let open = false
  let unresolved = false
  const pending = () => open && clock() <= until
  return {
    start(untilMs) {
      open = true
      unresolved = true
      until = untilMs
    },
    answered() {
      const ok = pending()
      open = false
      return ok
    },
    cancel() {
      open = false
      unresolved = false
    },
    pending,
    unresolved: () => unresolved,
  }
}
