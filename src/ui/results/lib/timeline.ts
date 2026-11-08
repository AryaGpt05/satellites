/**
 * Timeline geometry: day/night for THIS place, local day boundaries, lanes and hit-testing.
 * Pure, so it is unit-tested and can be computed once per report.
 */
import { sunElevationDeg } from '@/lib/geo'
import type { Pass } from '@/types'
import { VERDICTS, type Verdict } from './meta'
import { partsAtOffset, windowOffset, type LocalParts } from './time'

export const SUN_SAMPLE_MS = 10 * 60_000

/** Sun elevation at the place every 10 minutes across [t0, t1] (inclusive of both ends). */
export function sunSamples(lat: number, lon: number, t0: number, t1: number, stepMs = SUN_SAMPLE_MS): Float32Array {
  const n = Math.max(2, Math.ceil((t1 - t0) / stepMs) + 1)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = sunElevationDeg(lat, lon, Math.min(t1, t0 + i * stepMs))
  return out
}

/**
 * Daylight weight 0..1 from sun elevation: 0 below civil twilight (−6°), 1 above +6°, smooth between.
 * This is data (the actual twilight at the place), not decoration.
 */
export function daylight(elevDeg: number): number {
  const t = Math.min(1, Math.max(0, (elevDeg + 6) / 12))
  return t * t * (3 - 2 * t)
}

export interface DayMark {
  /** Instant of local midnight */
  t: number
  /** "Sun 1 Nov" */
  label: string
  /** Day-of-month, for compact labels */
  day: number
  weekday: string
}

/**
 * Local midnights inside (t0, t1], found by stepping 15 minutes (every real UTC offset is a multiple
 * of 15 min, so the step lands exactly on midnight, DST transitions included). The zone's offset is
 * resolved once for the window (windowOffset), so the ~670 steps cost no Intl work.
 */
export function dayBoundaries(t0: number, t1: number, timeZone: string): DayMark[] {
  const STEP = 15 * 60_000
  const offset = windowOffset(t0, t1, timeZone)
  const keyOf = (p: LocalParts) => p.year * 10_000 + p.month * 100 + p.day
  const out: DayMark[] = []
  let prev = keyOf(partsAtOffset(t0, offset(t0)))
  for (let t = Math.ceil(t0 / STEP) * STEP; t <= t1; t += STEP) {
    const p = partsAtOffset(t, offset(t))
    const key = keyOf(p)
    if (key !== prev) {
      out.push({ t, label: `${p.weekday} ${p.day} ${p.monthName}`, day: p.day, weekday: p.weekday })
      prev = key
    }
  }
  return out
}

/** Local clock hours that are multiples of `every` (not midnight), on the 15-minute grid. */
export function hourMarks(t0: number, t1: number, timeZone: string, every = 6): { t: number; hour: number }[] {
  const STEP = 15 * 60_000
  const offset = windowOffset(t0, t1, timeZone)
  const out: { t: number; hour: number }[] = []
  for (let t = Math.ceil(t0 / STEP) * STEP; t <= t1; t += STEP) {
    const p = partsAtOffset(t, offset(t))
    if (p.minute === 0 && p.hour !== 0 && p.hour % every === 0) out.push({ t, hour: p.hour })
  }
  return out
}

/** Lane order, top to bottom. */
export const LANES: readonly Verdict[] = VERDICTS

export interface LaneIndex {
  /** passes of this lane sorted by tClosest */
  passes: Pass[]
  times: Float64Array
}

export function indexLanes(passes: readonly Pass[]): Record<Verdict, LaneIndex> {
  const out = {} as Record<Verdict, LaneIndex>
  for (const v of LANES) {
    const ps = passes.filter((p) => p.verdict === v).sort((a, b) => a.tClosest - b.tClosest)
    out[v] = { passes: ps, times: Float64Array.from(ps.map((p) => p.tClosest)) }
  }
  return out
}

/** Index of the time in a sorted array nearest to t (−1 for an empty array). */
export function nearestIndex(times: ArrayLike<number>, t: number): number {
  const n = times.length
  if (!n) return -1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t)) return lo - 1
  return lo
}

/**
 * The pass nearest to time `t` within `tolMs`, preferring the given lane and then lanes in order of
 * interest (an image beats a geometry-only pass at the same spot).
 */
export function hitTest(lanes: Record<Verdict, LaneIndex>, t: number, tolMs: number, preferLane?: Verdict): Pass | undefined {
  const order: Verdict[] = preferLane ? [preferLane, ...LANES.filter((l) => l !== preferLane)] : [...LANES]
  for (const lane of order) {
    const L = lanes[lane]
    const i = nearestIndex(L.times, t)
    if (i >= 0 && Math.abs(L.times[i] - t) <= tolMs) return L.passes[i]
  }
  return undefined
}

/**
 * Keyboard stepping (←/→): the previous/next pass in time WITH THE SAME VERDICT as the selection, so
 * stepping through 40 photographs never lands on one of 1,500 "could have" passes. With nothing
 * selected, → starts at the earliest photograph and ← at the latest (falling back through the lanes).
 */
export function stepPass(lanes: Record<Verdict, LaneIndex>, current: Pass | undefined, dir: 1 | -1): Pass | undefined {
  if (!current) {
    for (const v of LANES) {
      const ps = lanes[v].passes
      if (ps.length) return dir > 0 ? ps[0] : ps[ps.length - 1]
    }
    return undefined
  }
  const ps = lanes[current.verdict].passes
  const i = ps.findIndex((p) => p.id === current.id)
  if (i < 0) return ps.length ? ps[0] : undefined
  const j = i + dir
  return j >= 0 && j < ps.length ? ps[j] : current
}
