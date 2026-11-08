/**
 * One shared wall-clock ticker for the whole UI, aligned to UTC second boundaries, so every readout
 * that shows the time (and the blinking live dot) changes on the same frame.
 */
import { useSyncExternalStore } from 'react'

let now = Date.now()
let timer: ReturnType<typeof setTimeout> | undefined
const subs = new Set<() => void>()

function schedule() {
  // +4 ms so we land just after the boundary, never just before it.
  timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 4)
}
function tick() {
  now = Date.now()
  for (const f of subs) f()
  if (subs.size) schedule()
}
function onVisible() {
  if (document.visibilityState === 'visible' && subs.size) {
    clearTimeout(timer)
    tick()
  }
}

function subscribe(f: () => void) {
  subs.add(f)
  if (subs.size === 1) {
    now = Date.now()
    schedule()
    document.addEventListener('visibilitychange', onVisible)
  }
  return () => {
    subs.delete(f)
    if (!subs.size) {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }
}

/** Epoch ms, re-rendering once per wall-clock second. */
export function useSecondClock(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  )
}

/** Negative animation-delay that phase-locks a 1 s CSS animation to the wall-clock second. */
export const secondPhaseDelay = () => `${-(Date.now() % 1000)}ms`
