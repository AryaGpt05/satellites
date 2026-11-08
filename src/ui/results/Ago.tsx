/**
 * <Ago t base/>: "40 h ago", re-rendered on its own every 30 s. One shared ticker for every row
 * (useSyncExternalStore), so the passing of time never re-renders the results view or the list.
 *
 * "Now" is report-relative: the report's end plus however long it has been on screen. In the app
 * that is wall-clock now; for a report computed for an earlier window (a shared pass, a fixture) it
 * stays consistent with "in the last 7 days".
 */
import { useSyncExternalStore } from 'react'
import { fmtRelative } from './lib/time'
import type { ReportClock } from './model'

const TICK_MS = 30_000
const listeners = new Set<() => void>()
let now = Date.now()
let timer = 0

function subscribe(cb: () => void) {
  listeners.add(cb)
  if (!timer) {
    now = Date.now()
    timer = window.setInterval(() => {
      now = Date.now()
      for (const l of listeners) l()
    }, TICK_MS)
  }
  return () => {
    listeners.delete(cb)
    if (!listeners.size && timer) {
      window.clearInterval(timer)
      timer = 0
    }
  }
}
const snapshot = () => now

/** Report-relative now (ticks every 30 s). */
export function useReportNow(base: ReportClock): number {
  const wall = useSyncExternalStore(subscribe, snapshot, snapshot)
  return base.end + Math.max(0, wall - base.at)
}

/** Report-relative now without subscribing (for one-off labels). */
export const reportNow = (base: ReportClock) => base.end + Math.max(0, Date.now() - base.at)

export function Ago({ t, base, className }: { t: number; base: ReportClock; className?: string }) {
  const n = useReportNow(base)
  return <span className={className}>{fmtRelative(t, n)}</span>
}
