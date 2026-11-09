/**
 * Everything derived from a report that the results UI needs, computed once per report.
 *
 * Split in two (PERF-03): the place/window part (time zone, sun samples, day and hour marks: the expensive
 * Intl + astronomy work) is cached on [lat, lon, windowStart, windowEnd], so the partial → final report swap
 * only regroups passes. Per-pass local time strings are formatted lazily and cached for the life of the report.
 *
 * R2R7: the whole model is a pure function of the report (`buildResultsModel`), cached per Report object.
 * The controller calls `prewarmResultsModel(report)` in idle time before the handoff, so the render that shows
 * the results only reads the cache.
 */
import { timeZoneAt } from '@/imagery'
import type { Pass, Report } from '@/types'
import { pickBestLook, type BestLook } from './lib/bestLook'
import { archiveDown, headline, type Headline } from './lib/copy'
import { groupPasses, type PassGroup } from './lib/groups'
import { orderPhotos, type CoverKind, type Photo } from './lib/photos'
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
  /** Every photo, in the one gallery order (owner B1 + D1): the cover, then newest first */
  photos: Photo[]
  /** The cover (photos[0]) and why it leads */
  cover?: { photo: Photo; why: CoverKind }
  /** Photos of the window (the clear cover from before it excluded) */
  windowPhotos: number
  /** Photo key by pass id (imaged passes with a capture) */
  photoByPass: Map<string, string>
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

/** Place/window models, anchored once per place/window (the final report never moves them). */
const placeCache = new Map<string, PlaceModel>()
const clockCache = new Map<string, ReportClock>()
const modelCache = new WeakMap<Report, ResultsModel>()

function cachedPlace(lat: number, lon: number, t0: number, t1: number): PlaceModel {
  const key = `${lat},${lon},${t0},${t1}`
  let v = placeCache.get(key)
  if (!v) {
    v = placeModel(lat, lon, t0, t1)
    placeCache.set(key, v)
    if (placeCache.size > 8) placeCache.delete(placeCache.keys().next().value as string)
  }
  return v
}

/** "Now" for relative times is anchored once per place/window, so the final report doesn't move it. */
function cachedClock(report: Report): ReportClock {
  const key = `${report.windowEnd}|${report.place.lat}|${report.place.lon}`
  let v = clockCache.get(key)
  if (!v) {
    v = { end: report.windowEnd, at: Math.max(Date.now(), report.generatedAt ?? 0) }
    clockCache.set(key, v)
    if (clockCache.size > 8) clockCache.delete(clockCache.keys().next().value as string)
  }
  return v
}

/** The results model of a report (pure, apart from the module caches above). */
export function buildResultsModel(report: Report, place = cachedPlace(report.place.lat, report.place.lon, report.windowStart, report.windowEnd), clock = cachedClock(report)): ResultsModel {
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
  const set = orderPhotos(report)
  const photoByPass = new Map<string, string>()
  for (const ph of set.photos) if (ph.pass) photoByPass.set(ph.pass.id, ph.key)
  return {
    report,
    ...place,
    meta: satMeta,
    passById: new Map(report.passes.map((p) => [p.id, p])),
    lanes: indexLanes(report.passes),
    groups: groupPasses(report, satMeta, { archiveFailed, photos: set.photos }),
    head: headline(report, satMeta, place.sunMax),
    best: pickBestLook(report),
    archiveFailed,
    times,
    clock,
    photos: set.photos,
    cover: set.cover,
    windowPhotos: set.windowCount,
    photoByPass,
  }
}

/** Run `cb` in a task of its own, queued now (ahead of any timer the caller sets after this returns). */
function nextTask(cb: () => void): void {
  if (typeof MessageChannel === 'undefined') {
    setTimeout(cb, 0)
    return
  }
  const c = new MessageChannel()
  c.port1.onmessage = () => {
    c.port1.close()
    cb()
  }
  c.port2.postMessage(0)
}

/**
 * Build (and cache) the model of a report ahead of its first render: call it in idle time (R2R7). In two tasks (U-1):
 * the place and window first (sun every 10 minutes, day and hour marks, the time zone), then the report's own parts in
 * a task queued right behind it, so neither is a long task on a phone (one build was 141 ms at 4× CPU). If the
 * render comes first, it builds what is missing itself, as before.
 */
export function prewarmResultsModel(report: Report): void {
  if (modelCache.has(report)) return
  const { lat, lon } = report.place
  if (!placeCache.has(`${lat},${lon},${report.windowStart},${report.windowEnd}`)) {
    cachedPlace(lat, lon, report.windowStart, report.windowEnd)
    nextTask(() => {
      if (!modelCache.has(report)) modelCache.set(report, buildResultsModel(report))
    })
    return
  }
  modelCache.set(report, buildResultsModel(report))
}

/** The model of a report, from the cache when prewarmed (identical object), else built now and cached. */
export function getResultsModel(report: Report): ResultsModel {
  let m = modelCache.get(report)
  if (!m) {
    m = buildResultsModel(report)
    modelCache.set(report, m)
  }
  return m
}

export function useResultsModel(report: Report | undefined): ResultsModel | undefined {
  return report ? getResultsModel(report) : undefined
}
