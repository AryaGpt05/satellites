/**
 * computeReport: everything that passed over a place in the last N days, and the real images.
 *
 *   STAC archive search (network) ───────────────────────────────────────┐
 *   catalog ─► targets ─┬─► GIBS satellites' passes (first, 1 per worker) ─► GIBS mosaics, 1 per (sat, day) ─┐
 *                       └─► all other passes (workers) ─────────────────┴─► match ─► [onPartial] ─► match ─┴─► Report
 *
 * Everything that can overlap does: the STAC search needs nothing from the catalog, so it is sent
 * first, and the five GIBS satellites are propagated ahead of everything else so NASA's slow pixel
 * probes start within ~50 ms of the catalog (when the workers are warm). Pass search is ~0.3–0.6 s for
 * a week; the network legs dominate: STAC ~0.5–1.1 s, GIBS 3–5 s cold for the last probe.
 *
 * Time budget: the report must land in under 4 s (docs/ARCHITECTURE.md). The GIBS leg is the only
 * one whose tail we can't control, so it is the one that gets cut: at `budgetMs` (default 3.5 s; never
 * sooner than 1.2 s after its first probe, and never before the STAC leg is done, since we wait for that
 * anyway) the report keeps every mosaic verified so far, aborts the rest, and says so in a note. Those
 * passes stay 'likely', which is exactly what we know about them.
 *
 * `onPartial` delivers a complete report (geometry + Sentinel-2/Landsat matches) as soon as the STAC leg
 * is done, so the UI can show results while the weather mosaics are still being verified; the final
 * report then adds the GIBS 'imaged' upgrades.
 *
 * Imagery is never allowed to fail the report: timeouts and outages degrade to geometry-only passes,
 * with a plain-language note in `notes`. Only an abort rejects (AbortError).
 */
import { MS_PER_DAY } from '@/lib/geo'
import { searchCapturesDetailed } from '@/imagery'
import type { Capture, GeoWatcher, LatLon, Pass, Place, ProgressEvent, Report } from '@/types'
import { getRow, getSatInfo, loadCatalog, satrecFor, type LoadedCatalog } from './catalog'
import { geoWatchers } from './geostationary'
import { attachCaptures, attachDailyCaptures, captureNorad, MATCH_AFTER_MS, MATCH_BEFORE_MS } from './match'
import { passNear, passTargetFor, type PassTarget } from './passes'
import { passWorkerCount, runPassSearch, warmPassWorkers } from './pool'
import { startWeatherLeg } from './weather'

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
  /**
   * Time budget in ms from the call, after which NASA GIBS verifications still in flight are dropped
   * (default 3,500). The STAC leg is never cut by the budget, only by its own 20 s timeout.
   */
  budgetMs?: number
}

export interface ReportTimings {
  catalogMs: number
  passesMs: number
  /** STAC search, measured from its start (it overlaps the catalog and the pass search) */
  archiveMs: number
  /** GIBS verification, from its first probe to its last answer (or the budget cut) */
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

export const REPORT_BUDGET_MS = 3_500
/** However late the GIBS leg starts (slow device), give it at least this long before cutting it. */
const MIN_WEATHER_MS = 1_200
const ARCHIVE_TIMEOUT_MS = 20_000
const STALE_CATALOG_MS = 3 * MS_PER_DAY

const nf = new Intl.NumberFormat('en-US')
const plural = (n: number, one: string, many = `${one}S`) => `${nf.format(n)} ${n === 1 ? one : many}`
const noop = () => undefined

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

/** Resolve when `p` settles or after `ms`, whichever is first; reject (AbortError) if `signal` aborts. */
function waitAtMost(p: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(finish, Math.max(0, ms))
    signal?.addEventListener('abort', onAbort, { once: true })
    p.then(finish, finish)
  })
}

/** Call a caller-supplied callback; a throwing UI callback must not take the report down with it. */
function safely<A>(fn: ((a: A) => void) | undefined, arg: A) {
  if (!fn) return
  try {
    fn(arg)
  } catch (err) {
    console.error('computeReport callback threw:', err)
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

/** An archive scene contains the place, so its pass came this close at least (half swath + scene slop). */
const ORPHAN_MAX_GROUND_KM = 300

/**
 * Scenes that matched no predicted pass (low sun, place at the scene edge): resolve the overflight
 * geometrically around the scene time and report it, because the photograph is the ground truth.
 * A minimum on the edge of the search window, or one too far away to have produced the scene, means
 * the overflight is not in the window (stale elements, a manoeuvre): no pass is invented then.
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
    const from = c.datetime - MATCH_BEFORE_MS
    const to = c.datetime + MATCH_AFTER_MS
    const p = passNear(satrec, target, place, from, to, 'imaged')
    if (!p || p.tClosest - from < 60_000 || to - p.tClosest < 60_000 || p.groundDistanceKm > ORPHAN_MAX_GROUND_KM) continue
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
  const { signal } = opts
  const tStart = performance.now()
  const budgetMs = opts.budgetMs ?? REPORT_BUDGET_MS
  const days = opts.days ?? 7
  const windowEnd = opts.now ?? Date.now()
  const windowStart = windowEnd - days * MS_PER_DAY
  const latLon = { lat: place.lat, lon: place.lon }
  const notes: string[] = []
  const emit = (stage: ProgressEvent['stage'], message: string, fraction?: number) => safely(opts.onProgress, { stage, message, fraction })
  throwIfAborted(signal)

  // ── STAC archive search: needs nothing from the catalog, so it goes out first ──
  emit('catalog', 'LOADING ORBITAL CATALOG', 0.02)
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
  // It only rejects on abort, possibly while we await something else: never leave that unhandled.
  archive.catch(noop)
  // Spawn the pass workers now (no-op when warm) so their start-up overlaps the catalog download.
  warmPassWorkers()

  // ── catalog ───────────────────────────────────────────────────────────────
  // Shared with the globe and the HUD: our signal stops our wait, never the shared download.
  const cat = await loadCatalog(undefined, signal)
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

  // ── passes: GIBS satellites first, one per worker; everything else behind them ──
  const passStart = performance.now()
  const query = { place: latLon, t0: windowStart, t1: windowEnd }
  const hasGibs = (t: PassTarget) => getSatInfo(t.norad)?.profile?.gibs?.kind === 'daily'
  const done = { gibs: 0, other: 0 }
  const onPassProgress = () => {
    const n = done.gibs + done.other
    emit('propagate', `PROPAGATING ORBITS · ${nf.format(n)} / ${nf.format(targets.length)}`, 0.06 + 0.64 * (n / Math.max(1, targets.length)))
  }
  emit('propagate', `PROPAGATING ${plural(targets.length, 'ORBIT')} · ${days} DAYS`, 0.06)
  const gibsPasses = runPassSearch(targets.filter(hasGibs), query, {
    signal,
    chunkSize: 1,
    onProgress: (n) => ((done.gibs = n), onPassProgress()),
  })
  const otherPasses = runPassSearch(
    targets.filter((t) => !hasGibs(t)),
    query,
    { signal, onProgress: (n) => ((done.other = n), onPassProgress()) },
  )

  // ── GIBS daily mosaics: start as soon as the GIBS satellites' passes exist ──
  let verifying = false // progress for the GIBS leg is only shown once it is what we wait for
  const weather = startWeatherLeg(latLon, gibsPasses, {
    signal,
    onSettle: (n, total) => {
      if (verifying) emit('match', `VERIFYING NASA WEATHER MOSAICS · ${nf.format(n)} / ${nf.format(total)}`, 0.86 + 0.13 * (n / total))
    },
  })

  let passes: Pass[]
  try {
    passes = (await Promise.all([gibsPasses, otherPasses])).flat()
  } catch (err) {
    weather.stop()
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
    const { startedAt, finishedAt } = weather.timing()
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
        weatherMs: startedAt ? (finishedAt || performance.now()) - startedAt : 0,
        firstResultMs,
        totalMs: performance.now() - tStart,
        workers: passWorkerCount(),
      },
    }
  }

  // ── STAC scenes ───────────────────────────────────────────────────────────
  if (!archiveDone) emit('archive', 'SEARCHING SENTINEL-2 + LANDSAT ARCHIVES', 0.72)
  let stac: Capture[]
  try {
    stac = await archive
  } catch (err) {
    weather.stop()
    throw err
  }
  throwIfAborted(signal)
  emit('match', `MATCHING ${plural(stac.length, 'SCENE')} TO ${plural(passes.length, 'PASS', 'PASSES')}`, 0.8)
  const orphans = attachCaptures(passes, stac)
  passes.push(...passesForOrphanScenes(cat, latLon, orphans, passes))

  let firstResultMs = 0
  if (!weather.isDone() && opts.onPartial) {
    firstResultMs = performance.now() - tStart
    // Snapshot: the final report mutates verdicts on these passes, so hand out copies.
    safely(opts.onPartial, build(passes.map((p) => ({ ...p })), [...stac], true, firstResultMs))
  }

  // ── GIBS mosaics, within the time budget ─────────────────────────────────
  if (!weather.isDone()) {
    verifying = true
    const { total, settled } = weather.progress()
    emit('match', total ? `VERIFYING NASA WEATHER MOSAICS · ${nf.format(settled)} / ${nf.format(total)}` : 'VERIFYING NASA WEATHER MOSAICS', 0.86 + 0.13 * (total ? settled / total : 0))
    const startedAt = weather.timing().startedAt || performance.now()
    const deadline = Math.max(tStart + budgetMs, startedAt + MIN_WEATHER_MS)
    try {
      await waitAtMost(weather.settled, deadline - performance.now(), signal)
    } catch (err) {
      weather.stop()
      throw err
    }
  }
  const cut = weather.stop()
  const { total: mosaics, failed } = weather.progress()
  const missing = cut + failed
  if (missing > 0) {
    const all = missing >= mosaics
    notes.push(
      cut > 0
        ? all
          ? 'NASA GIBS did not answer in time, so weather-satellite images are not shown.'
          : `NASA GIBS did not return ${nf.format(missing)} of ${nf.format(mosaics)} weather-satellite images in time; those passes are shown as likely.`
        : all
          ? 'NASA GIBS could not be reached, so weather-satellite images are not shown.'
          : `NASA GIBS failed to return ${nf.format(missing)} of ${nf.format(mosaics)} weather-satellite images; those passes are shown as likely.`,
    )
  }
  const weatherMatched = attachDailyCaptures(passes, weather.verified())
  const report = build(passes, [...stac, ...weatherMatched], false, firstResultMs || performance.now() - tStart)
  emit('done', `${plural(report.counts.passes, 'PASS', 'PASSES')} · ${plural(report.counts.imaged, 'IMAGE')}`, 1)
  return report
}
