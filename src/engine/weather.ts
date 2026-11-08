/**
 * The NASA GIBS leg of a report: daily VIIRS / MODIS true-colour mosaics for the weather-LEO passes.
 *
 * The imagery module renders a tiny probe per mosaic and drops the ones that are empty at the place
 * (not processed yet, swath gap, instrument outage). GIBS renders WMS on demand and answers a single
 * browser connection in a staircase: measured cold in Chromium, 35 probes take 1.4–2.3 s median and
 * 3.0–4.8 s for the last one. That tail alone would break the report's 4-second contract.
 *
 * So verification is issued one mosaic per call (one `weatherCaptures` call per satellite and UTC day,
 * which is exactly one candidate, since daily mosaics are one image per layer per UTC day), results
 * are collected as they land, and the report can `stop()` at its time budget: everything verified by
 * then is kept, the stragglers are aborted and counted so the report can say so.
 */
import { weatherCaptures } from '@/imagery'
import type { Capture, LatLon, Pass } from '@/types'
import { getSatInfo } from './catalog'
import { utcDay } from './match'

export interface WeatherLeg {
  /** Resolves once every verification has settled, or the leg was stopped. Never rejects. */
  readonly settled: Promise<void>
  /** Captures verified so far, newest first. */
  verified(): Capture[]
  /** True once every verification has settled. */
  isDone(): boolean
  /** Mosaics being verified (known once the passes exist), settled, and failed (rejected). */
  progress(): { total: number; settled: number; failed: number }
  /** Stop waiting: abort the verifications still in flight. Returns how many were cut. */
  stop(): number
  /** performance.now() of the first request (0 if none was needed) and of the end (0 while running) */
  timing(): { startedAt: number; finishedAt: number }
}

/** Passes of satellites whose daily mosaics GIBS serves, grouped by (satellite, UTC day). */
export function mosaicGroups(passes: readonly Pass[]): Pass[][] {
  const groups = new Map<string, Pass[]>()
  for (const p of passes) {
    if (getSatInfo(p.norad)?.profile?.gibs?.kind !== 'daily') continue
    const key = `${p.norad}@${utcDay(p.tClosest)}`
    const g = groups.get(key)
    if (g) g.push(p)
    else groups.set(key, [p])
  }
  return [...groups.values()]
}

/**
 * Start verifying the daily mosaics as soon as `passes` (the GIBS satellites' passes) resolve.
 * `onSettle` fires after each mosaic is settled. Aborting `signal` aborts every request.
 */
export function startWeatherLeg(
  place: LatLon,
  passes: Promise<Pass[]>,
  opts: { signal?: AbortSignal; onSettle?: (settled: number, total: number) => void } = {},
): WeatherLeg {
  const ctl = new AbortController()
  const onOuterAbort = () => ctl.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })

  const found: Capture[] = []
  const inFlight = new Set<number>()
  let total = 0
  let settledCount = 0
  let failed = 0
  let stopped = false
  let done = false
  let startedAt = 0
  let finishedAt = 0
  let release: () => void = () => undefined
  const stoppedSignal = new Promise<void>((r) => (release = r))

  const work = passes
    .then(async (list) => {
      if (stopped || ctl.signal.aborted) return
      const groups = mosaicGroups(list)
      total = groups.length
      if (!total) return
      startedAt = performance.now()
      await Promise.all(
        groups.map((group, i) => {
          inFlight.add(i)
          return weatherCaptures(place, group, ctl.signal)
            .then(
              (caps) => {
                if (!stopped) found.push(...caps)
              },
              () => {
                // weatherCaptures only rejects on abort; anything else counts as an unanswered mosaic.
                if (!stopped) failed++
              },
            )
            .finally(() => {
              inFlight.delete(i)
              if (stopped) return
              settledCount++
              opts.onSettle?.(settledCount, total)
            })
        }),
      )
    })
    // A failed or aborted pass search is reported by the pass leg; this leg just ends empty.
    .catch(() => undefined)
    .finally(() => {
      done = true
      finishedAt ||= performance.now()
      opts.signal?.removeEventListener('abort', onOuterAbort)
    })

  return {
    settled: Promise.race([work, stoppedSignal]),
    verified: () => [...found].sort((a, b) => b.datetime - a.datetime),
    isDone: () => done,
    progress: () => ({ total, settled: settledCount, failed }),
    stop: () => {
      if (stopped) return 0
      stopped = true
      const cut = done ? 0 : inFlight.size
      if (!done) finishedAt = performance.now()
      ctl.abort()
      release()
      return cut
    },
    timing: () => ({ startedAt, finishedAt }),
  }
}
