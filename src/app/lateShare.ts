/**
 * A share lookup that outlived boot and may still open (controller.adoptLateShare). While it is pending the landing
 * keeps ?s= in the address bar. It stops being pending when the lookup answers, when its window closes, or when the
 * visitor starts a search of their own: a landing they come back to is then clean, and the late answer can no longer
 * open the share unasked.
 */
export interface LateShareGate {
  /** The lookup outlived boot: pending until `untilMs` (a performance.now() time) at the latest. */
  start(untilMs: number): void
  /** The lookup answered: true if it may still open (it was pending, inside its window). Ends the pending state. */
  answered(): boolean
  /** The visitor started their own search. */
  cancel(): void
  pending(): boolean
}

export function createLateShareGate(clock: () => number = () => performance.now()): LateShareGate {
  let until = -Infinity
  let open = false
  const pending = () => open && clock() <= until
  return {
    start(untilMs) {
      open = true
      until = untilMs
    },
    answered() {
      const ok = pending()
      open = false
      return ok
    },
    cancel() {
      open = false
    },
    pending,
  }
}
