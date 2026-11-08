/**
 * Everything derived from a report that the results UI needs, computed once per report.
 *
 * Split in two memos (PERF-03): the place/window part (time zone, sun samples, day and hour marks:
 * the expensive Intl + astronomy work) is keyed on [lat, lon, windowStart, windowEnd], so the
 * partial → final report swap only regroups passes. Per-pass local time strings are formatted
 * lazily and cached for the life of the report.
 */
import { useMemo } from 'react'
import { timeZoneAt } from '@/imagery'
import type { Pass, Report } from '@/types'
import { pickBestLook, type BestLook } from './lib/bestLook'
import { archiveDown, headline, type Headline } from './lib/copy'
import { groupPasses, type PassGroup } from './lib/groups'
import type { MetaFn, Verdict } from './lib/meta'
import { dayBoundaries, hourMarks, indexLanes, sunSamples, type DayMark, type LaneIndex } from './lib/timeline'
import { fmtLocalDay, fmtLocalTime, zoneAbbr, zoneLabel } from './lib/time'
import { satMeta } from './sats'

/** Local time strings of one pass at the place, formatted once. */
export interface PassTimes {
  /** "Sun 1 Nov" */
  day: string
  /** "11:21" */
  time: string
  /** "11:21:13" */
  timeS: string
  /** "EST" */
  zone: string
  /** "Sun 1 Nov · 11:21 EST" */
  stamp: string
}

/** Report-relative "now" for relative times: see ./Ago.tsx. */
export interface ReportClock {
  /** The report window's end */
  end: number
  /** Wall-clock ms at which `end` was "now" (the report's generation, or when it was first shown) */
  at: number
}

export interface ResultsModel {
  report: Report
  tz: string
  /** "America/Toronto", or "UTC−9 · at sea" for nautical zones */
  tzLabel: string
  meta: MetaFn
  passById: Map<string, Pass>
  lanes: Record<Verdict, LaneIndex>
  groups: PassGroup[]
  head: Headline
  best: BestLook | null
  /** The Sentinel-2 / Landsat archives failed (≠ answered with nothing) */
  archiveFailed: boolean
  sun: Float32Array
  sunMax: number
  days: DayMark[]
  hours: { t: number; hour: number }[]
  /** window length in days (usually 7) */
  windowDays: number
  /** Local time strings for a pass (cached) */
  times: (p: Pass) => PassTimes
  clock: ReportClock
}

interface PlaceModel {
  tz: string
  tzLabel: string
  sun: Float32Array
  sunMax: number
  days: DayMark[]
  hours: { t: number; hour: number }[]
  windowDays: number
}

function placeModel(lat: number, lon: number, t0: number, t1: number): PlaceModel {
  const tz = timeZoneAt(lat, lon)
  const sun = sunSamples(lat, lon, t0, t1)
  let sunMax = -90
  for (let i = 0; i < sun.length; i++) if (sun[i] > sunMax) sunMax = sun[i]
  return {
    tz,
    tzLabel: zoneLabel(t1, tz),
    sun,
    sunMax,
    days: dayBoundaries(t0, t1, tz),
    hours: hourMarks(t0, t1, tz, 6),
    windowDays: (t1 - t0) / 86_400_000,
  }
}

export function useResultsModel(report: Report | undefined): ResultsModel | undefined {
  const lat = report?.place.lat
  const lon = report?.place.lon
  const t0 = report?.windowStart
  const t1 = report?.windowEnd
  const place = useMemo(
    () => (lat === undefined || lon === undefined || t0 === undefined || t1 === undefined ? undefined : placeModel(lat, lon, t0, t1)),
    [lat, lon, t0, t1],
  )
  // "Now" for relative times is anchored once per place/window, so the final report doesn't move it.
  const clock = useMemo<ReportClock | undefined>(
    () => (t1 === undefined ? undefined : { end: t1, at: Math.max(Date.now(), report?.generatedAt ?? 0) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t1, lat, lon],
  )
  return useMemo(() => {
    if (!report || !place || !clock) return undefined
    const archiveFailed = archiveDown(report)
    const cache = new Map<string, PassTimes>()
    const tz = place.tz
    const times = (p: Pass): PassTimes => {
      let v = cache.get(p.id)
      if (!v) {
        const day = fmtLocalDay(p.tClosest, tz)
        const timeS = fmtLocalTime(p.tClosest, tz, true)
        const time = timeS.slice(0, 5)
        const zone = zoneAbbr(p.tClosest, tz)
        v = { day, time, timeS, zone, stamp: `${day} · ${time} ${zone}` }
        cache.set(p.id, v)
      }
      return v
    }
    return {
      report,
      ...place,
      meta: satMeta,
      passById: new Map(report.passes.map((p) => [p.id, p])),
      lanes: indexLanes(report.passes),
      groups: groupPasses(report, satMeta, { archiveFailed }),
      head: headline(report, satMeta, place.sunMax),
      best: pickBestLook(report),
      archiveFailed,
      times,
      clock,
    }
  }, [report, place, clock])
}
