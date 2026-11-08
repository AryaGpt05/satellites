/**
 * computeReport: everything that passed over a place in the last N days, and the real images.
 *
 *   catalog ─► targets ─┬─► weather-LEO passes (first worker job) ─► GIBS mosaics, per satellite ───────┐
 *                       ├─► all other passes (workers) ──────────────┐                                  │
 *                       └─► STAC archive search (network) ───────────┴─► match ─► [onPartial] ─► match ─┴─► Report
 *
 * Everything that can overlap does. Pass search is ~0.3–0.6 s for a week; the network legs dominate:
 * the STAC search (~0.5–1.5 s) and the GIBS pixel verification (~2–4 s, rendered on demand by NASA).
 * `onPartial` delivers a complete report (geometry + Sentinel-2/Landsat matches) as soon as the STAC leg
 * is done, so the UI can show results while the weather mosaics are still being verified; the final
 * report then adds the GIBS 'imaged' upgrades.
 *
 * Imagery is never allowed to fail the report: timeouts and outages degrade to geometry-only passes,
 * with a plain-language note in `notes`.
 */
import { MS_PER_DAY } from '@/lib/geo'
import { searchCapturesDetailed, weatherCaptures } from '@/imagery'
import type { Capture, GeoWatcher, LatLon, Pass, Place, ProgressEvent, Report } from '@/types'
import { getRow, getSatInfo, loadCatalog, satrecFor, type LoadedCatalog } from './catalog'
import { geoWatchers } from './geostationary'
import { attachCaptures, attachDailyCaptures, captureNorad, MATCH_AFTER_MS, MATCH_BEFORE_MS } from './match'
import { passNear, passTargetFor, type PassTarget } from './passes'
import { passWorkerCount, runPassSearch } from './pool'

export interface ReportOptions {
  days?: number
  now?: number
  onProgress?: (e: ProgressEvent) => void
  /**
   * Called at most once, before the final result, with a complete report that lacks only the GIBS
   * weather-mosaic matches (those passes are still 'likely'). Not called if nothing is pending by then.
   */
  onPartial?: (r: EngineReport) => void
  signal?: AbortSignal
}

export interface ReportTimings {
  catalogMs: number
  passesMs: number
  /** STAC search, measured from its start (it overlaps the pass search) */
  archiveMs: number
  /** GIBS verification, measured from its start (it overlaps the pass search and STAC) */
  weatherMs: number
  /** When the first usable report existed (partial or final) */
  firstResultMs: number
  totalMs: number
  /** Pass-search workers used (0 = main thread) */
  workers: number
}

/** The contract `Report`, plus caveats for footnotes and timings for diagnostics. */
export interface EngineReport extends Report {
  /** Plain sentences about degraded data (archive outage, stale elements). Empty when all is well. */
  notes: string[]
  /** True for the `onPartial` snapshot: GIBS weather mosaics not matched yet. */
  partial: boolean
  timings: ReportTimings
}

const ARCHIVE_TIMEOUT_MS = 20_000
const WEATHER_TIMEOUT_MS = 12_000
const STALE_CATALOG_MS = 3 * MS_PER_DAY

const nf = new Intl.NumberFormat('en-US')
const plural = (n: number, one: string, many = `${one}S`) => `${nf.format(n)} ${n === 1 ? one : many}`

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError')
}
function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}
const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError'

/** Run `fn` with a signal that aborts on the caller's signal or after `ms`. Rejects 'TimeoutError' on timeout. */
async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  outer?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort()
      reject(Object.assign(new Error(`Timed out after ${ms} ms`), { name: 'TimeoutError' }))
    }, ms)
  })
  try {
    return await Promise.race([fn(ctl.signal), timeout])
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
}

/** All satellites we predict passes for. */
export function passTargets(cat: LoadedCatalog): PassTarget[] {
  const out: PassTarget[] = []
  for (const s of cat.sats) {
    const row = getRow(s.norad)
    const t = row && passTargetFor(s, row)
    if (t) out.push(t)
  }
  return out
}

/**
 * GIBS daily mosaics for weather passes. One `weatherCaptures` call per satellite, in parallel, so
 * one slow layer doesn't hold the others and their pixel probes share the HTTP/2 connection.
 * Satellites whose call fails are skipped; rejects only if every call failed.
 */
async function dailyMosaics(place: LatLon, passes: Pass[], signal: AbortSignal): Promise<Capture[]> {
  const bySat = new Map<number, Pass[]>()
  for (const p of passes) {
    if (!getSatInfo(p.norad)?.profile?.gibs) continue
    const list = bySat.get(p.norad)
    if (list) list.push(p)
    else bySat.set(p.norad, [p])
  }
  if (!bySat.size) return []
  const settled = await Promise.allSettled([...bySat.values()].map((list) => weatherCaptures(place, list, signal)))
  throwIfAborted(signal)
  const ok = settled.filter((r): r is PromiseFulfilledResult<Capture[]> => r.status === 'fulfilled')
  if (!ok.length) throw (settled[0] as PromiseRejectedResult).reason
  return ok.flatMap((r) => r.value).sort((a, b) => b.datetime - a.datetime)
}

/**
 * Scenes that matched no predicted pass (low sun, place at the scene edge): resolve the overflight
 * geometrically around the scene time and report it, because the photograph is the ground truth.
 */
function passesForOrphanScenes(cat: LoadedCatalog, place: LatLon, scenes: Capture[], existing: Pass[]): Pass[] {
  const out: Pass[] = []
  const byId = new Map(existing.map((p) => [p.id, p]))
  for (const c of scenes) {
    const norad = captureNorad(c)
    const info = norad !== undefined ? cat.byNorad.get(norad) : undefined
    const row = info && getRow(info.norad)
    const target = info && row && passTargetFor(info, row)
    const satrec = target && satrecFor(target.norad)
    if (!target || !satrec) continue
    const p = passNear(satrec, target, place, c.datetime - MATCH_BEFORE_MS, c.datetime + MATCH_AFTER_MS, 'imaged')
    if (!p) continue
    const same = byId.get(p.id)
    if (same) {
      // Resolved to a pass we already have (or just added for another tile of the same overflight).
      if (same.verdict !== 'imaged') Object.assign(same, { verdict: 'imaged', captureId: c.id })
      continue
    }
    p.captureId = c.id
    byId.set(p.id, p)
    out.push(p)
  }
  return out
}

export async function computeReport(place: Place, opts: ReportOptions = {}): Promise<EngineReport> {
  const { signal, onProgress } = opts
  const tStart = performance.now()
  const days = opts.days ?? 7
  const windowEnd = opts.now ?? Date.now()
  const windowStart = windowEnd - days * MS_PER_DAY
  const latLon = { lat: place.lat, lon: place.lon }
  const notes: string[] = []
  const emit = (stage: ProgressEvent['stage'], message: string, fraction?: number) =>
    onProgress?.({ stage, message, fraction })

  // ── catalog ───────────────────────────────────────────────────────────────
  emit('catalog', 'LOADING ORBITAL CATALOG', 0.02)
  const cat = await loadCatalog() // shared with the globe; never aborted on behalf of one report
  throwIfAborted(signal)
  const catalogMs = performance.now() - tStart
  const targets = passTargets(cat)
  emit('catalog', `CATALOG · ${plural(cat.sats.length, 'OBJECT')}`, 0.06)
  // SGP4 error grows by roughly 1–3 km per day away from the element epoch, in either direction.
  const ageMs = windowEnd - Date.parse(cat.fetchedAt)
  if (ageMs > STALE_CATALOG_MS) {
    notes.push(`Orbital elements are ${Math.round(ageMs / MS_PER_DAY)} days old, so pass times may be off by a few minutes.`)
  } else if (-ageMs > STALE_CATALOG_MS) {
    notes.push('These passes are reconstructed from newer orbital elements, so their times may be off by a few minutes.')
  }

  // ── STAC archive search: starts now, overlaps everything else ─────────────
  const archiveStart = performance.now()
  let archiveMs = 0
  let archiveDone = false
  const archive = withTimeout((s) => searchCapturesDetailed(latLon, windowStart, windowEnd, s), ARCHIVE_TIMEOUT_MS, signal)
    .then((r) => {
      notes.push(...r.degraded)
      return r.captures
    })
    .catch((err): Capture[] => {
      if (isAbort(err) && signal?.aborted) throw err
      notes.push(
        err instanceof Error && err.name === 'TimeoutError'
          ? 'The Sentinel-2 and Landsat archives were too slow to answer; passes are shown from orbital geometry only.'
          : 'The Sentinel-2 and Landsat archives could not be reached; passes are shown from orbital geometry only.',
      )
      return []
    })
    .finally(() => {
      archiveMs = performance.now() - archiveStart
      archiveDone = true
    })

  // ── passes: weather-LEO first (GIBS needs them), everything else in parallel ──
  const passStart = performance.now()
  const query = { place: latLon, t0: windowStart, t1: windowEnd }
  const done = { weather: 0, other: 0 }
  const onPassProgress = () => {
    const n = done.weather + done.other
    emit('propagate', `PROPAGATING ORBITS · ${nf.format(n)} / ${nf.format(targets.length)}`, 0.06 + 0.64 * (n / Math.max(1, targets.length)))
  }
  emit('propagate', `PROPAGATING ${plural(targets.length, 'ORBIT')} · ${days} DAYS`, 0.06)
  const weatherPasses = runPassSearch(
    targets.filter((t) => t.category === 'weather-leo'),
    query,
    { signal, onProgress: (n) => ((done.weather = n), onPassProgress()) },
  )
  const otherPasses = runPassSearch(
    targets.filter((t) => t.category !== 'weather-leo'),
    query,
    { signal, onProgress: (n) => ((done.other = n), onPassProgress()) },
  )

  // ── GIBS daily mosaics: start as soon as the weather passes exist ─────────
  let weatherStart = 0
  let weatherMs = 0
  let weatherDone = false
  const weather = weatherPasses
    .then((wp) => {
      weatherStart = performance.now()
      return withTimeout((s) => dailyMosaics(latLon, wp, s), WEATHER_TIMEOUT_MS, signal)
    })
    .catch((err): Capture[] => {
      if (isAbort(err) && signal?.aborted) throw err
      notes.push('NASA GIBS did not answer in time; weather-satellite images are not shown.')
      return []
    })
    .finally(() => {
      weatherMs = weatherStart ? performance.now() - weatherStart : 0
      weatherDone = true
    })

  let passes: Pass[]
  try {
    passes = (await Promise.all([weatherPasses, otherPasses])).flat()
  } catch (err) {
    archive.catch(() => undefined) // no unhandled rejections left behind on abort
    weather.catch(() => undefined)
    throw err
  }
  const passesMs = performance.now() - passStart
  throwIfAborted(signal)

  const geo = geoWatchers(cat, latLon, windowStart, windowEnd)
  const satellitesConsidered = targets.length + cat.sats.filter((s) => s.category === 'weather-geo' && s.profile?.operational).length

  const build = (list: Pass[], captures: Capture[], partial: boolean, firstResultMs: number): EngineReport => {
    const sorted = [...list].sort((a, b) => a.tClosest - b.tClosest)
    const counts = { satellitesConsidered, passes: sorted.length, imaged: 0, likely: 0, could: 0, overhead: 0 }
    for (const p of sorted) counts[p.verdict]++
    return {
      place,
      windowStart,
      windowEnd,
      generatedAt: Date.now(),
      catalogFetchedAt: cat.fetchedAt,
      passes: sorted,
      captures,
      geo: geo.map((g): GeoWatcher => ({ ...g })),
      counts,
      notes: [...notes],
      partial,
      timings: {
        catalogMs,
        passesMs,
        archiveMs,
        weatherMs,
        firstResultMs,
        totalMs: performance.now() - tStart,
        workers: passWorkerCount(),
      },
    }
  }

  // ── STAC scenes ───────────────────────────────────────────────────────────
  if (!archiveDone) emit('archive', 'SEARCHING SENTINEL-2 + LANDSAT ARCHIVES', 0.72)
  const stac = await archive
  throwIfAborted(signal)
  emit('match', `MATCHING ${plural(stac.length, 'SCENE')} TO ${plural(passes.length, 'PASS', 'PASSES')}`, 0.8)
  const orphans = attachCaptures(passes, stac)
  passes.push(...passesForOrphanScenes(cat, latLon, orphans, passes))

  let firstResultMs = 0
  if (!weatherDone && opts.onPartial) {
    firstResultMs = performance.now() - tStart
    // Snapshot: the final report mutates verdicts on these passes, so hand out copies.
    opts.onPartial(build(passes.map((p) => ({ ...p })), [...stac], true, firstResultMs))
    emit('match', 'VERIFYING NASA WEATHER MOSAICS', 0.86)
  }

  // ── GIBS mosaics ──────────────────────────────────────────────────────────
  const daily = await weather
  throwIfAborted(signal)
  const weatherMatched = attachDailyCaptures(passes, daily)
  const report = build(passes, [...stac, ...weatherMatched], false, firstResultMs || performance.now() - tStart)
  emit('done', `${plural(report.counts.passes, 'PASS', 'PASSES')} · ${plural(report.counts.imaged, 'IMAGE')}`, 1)
  return report
}
