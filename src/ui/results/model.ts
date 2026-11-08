/**
 * Everything derived from a report that the results UI needs, computed once per report.
 */
import { useEffect, useMemo, useState } from 'react'
import { timeZoneAt } from '@/imagery'
import type { Pass, Report } from '@/types'
import { headline, type Headline } from './lib/copy'
import { groupPasses, type PassGroup } from './lib/groups'
import type { MetaFn } from './lib/meta'
import { dayBoundaries, hourMarks, indexLanes, sunSamples, type DayMark, type LaneIndex } from './lib/timeline'
import type { Verdict } from './lib/meta'
import { satMeta } from './sats'

export interface ResultsModel {
  report: Report
  tz: string
  meta: MetaFn
  passById: Map<string, Pass>
  lanes: Record<Verdict, LaneIndex>
  groups: PassGroup[]
  head: Headline
  sun: Float32Array
  days: DayMark[]
  hours: { t: number; hour: number }[]
  /** window length in days (usually 7) */
  days_n: number
}

export function useResultsModel(report: Report | undefined): ResultsModel | undefined {
  return useMemo(() => {
    if (!report) return undefined
    const { place, windowStart: t0, windowEnd: t1 } = report
    const tz = timeZoneAt(place.lat, place.lon)
    return {
      report,
      tz,
      meta: satMeta,
      passById: new Map(report.passes.map((p) => [p.id, p])),
      lanes: indexLanes(report.passes),
      groups: groupPasses(report, satMeta),
      head: headline(report, satMeta),
      sun: sunSamples(place.lat, place.lon, t0, t1),
      days: dayBoundaries(t0, t1, tz),
      hours: hourMarks(t0, t1, tz, 6),
      days_n: (t1 - t0) / 86_400_000,
    }
  }, [report])
}

/**
 * "Now" for relative times ("2 days ago"): the report's end plus however long it has been on screen.
 * In the app that is wall-clock now; for a report computed for an earlier window (a shared pass, a
 * sandbox fixture) it stays consistent with "in the last 7 days". Ticks every 30 s.
 */
export function useReportNow(report: Report | undefined): number {
  const [mountedAt] = useState(() => Date.now())
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])
  const end = report?.windowEnd ?? mountedAt
  return end + Math.max(0, Date.now() - Math.max(mountedAt, report?.generatedAt ?? mountedAt))
}
