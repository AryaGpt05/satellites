/**
 * App flow controller — the only place that sequences phases.
 *   boot → idle → (locating) → computing → results
 *   boot → computing → results            (share links and ?q deep links: the landing never mounts)
 * URL state:
 *   /?q=<lat>,<lon>&n=<label>[&p=<passId>]   deep link straight to a report
 *   /?s=<shareId>                            open a shared pass
 *
 * Timing contract (decision #10, one continuous instrument):
 *  - Boot waits only for the globe's first light and the fonts. The catalog loads in parallel (its points
 *    fade in on their own) and the share lookup starts at t=0, so a share link resolves while the boot log
 *    is still up and the curtain lifts straight onto the computing panel.
 *  - Results land in rhythm with the camera: no sooner than 1.8 s after the search, and ~1 s before the
 *    camera arrives, so the headline has settled just before the reticle locks. The final report gets a
 *    short head start (600 ms) so fast networks never show the partial headline, and the best-look hero is
 *    already decoded (up to 1.2 s more) so it never mounts on an empty frame.
 */
import { useApp } from '@/state/store'
import type { Capture, Place, ProgressEvent, Report } from '@/types'
import { currentCatalog, loadCatalog, loadCatalogNames } from '@/engine/catalog'
import { ensureTz } from '@/imagery'
import { getShare, recordLookup, type Share } from '@/lib/backend'

/**
 * The report engine (pass search, archives, matching, satellite.js) is its own chunk: the landing doesn't
 * need it. Prefetched at landing idle, on search focus, and at boot for deep links.
 */
export const loadEngine = (() => {
  let p: Promise<typeof import('@/engine/report')> | undefined
  return () => {
    p ??= import('@/engine/report')
    p.catch(() => (p = undefined))
    return p
  }
})()
const warmPassWorkers = () => void import('@/engine/pool').then((m) => m.warmPassWorkers(), () => undefined)

let inflight: AbortController | null = null
const DAY = 86_400_000

/** Share lookups that take longer than this (from the start of boot) fall back to the landing. */
const SHARE_CAP_MS = 4000
/** Results never land sooner than this after a search (the readout needs a beat to read). */
const MIN_DWELL_MS = 1800
/**
 * …and land this long before the camera arrives. The panel's handoff (readout out 160 ms, headline wipe
 * 480 ms, then the staggered blocks) then has the headline settled ~200 ms before arrival and the rest
 * landing with the reticle lock. (Plan K2 said 700 ms; measured, that put the headline 80 ms late.)
 */
const LEAD_BEFORE_ARRIVAL_MS = 1000
/** Never wait on the camera longer than this (a globe that stops reporting must not stall results). */
const MAX_CAMERA_WAIT_MS = 6000
/** A partial report waits this long for the final one before it is shown. */
const FINAL_RACE_MS = 600
/** The hero image gets at most this much extra time to decode. */
const HERO_RACE_MS = 1200
/** An archive outage is retried once, this long after the report landed. */
const ARCHIVE_RETRY_MS = 8000

// ───────────────────────────── boot ─────────────────────────────

type UrlTarget =
  | { kind: 'share'; id: string }
  | { kind: 'q'; place: Place; passId?: string }

/** What the address bar asks for (read once, at boot). */
function readUrlTarget(): UrlTarget | null {
  const params = new URLSearchParams(location.search)
  if (params.has('sandbox')) return null
  const shareId = params.get('s')
  if (shareId) return { kind: 'share', id: shareId }
  const q = params.get('q')
  if (q) {
    const [lat, lon] = q.split(',').map(Number)
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      const label = params.get('n') || `${lat.toFixed(3)}, ${lon.toFixed(3)}`
      return { kind: 'q', place: { label, lat, lon, source: 'url' }, passId: params.get('p') ?? undefined }
    }
  }
  return null
}

let catalogFailed = false
const CATALOG_ERROR = 'Could not load the orbit catalog. Check your connection and try again.'

/** Load the catalog in the background. A failure surfaces only when no report is running (that one reports it). */
function startCatalog() {
  catalogFailed = false
  loadCatalog().then(
    () => useApp.getState().setCatalogReady(true),
    (e: unknown) => {
      console.error(e)
      catalogFailed = true
      const phase = useApp.getState().phase
      if (phase === 'idle' || phase === 'locating') useApp.getState().setPhase('error', CATALOG_ERROR)
    },
  )
}

let booted = false

export async function boot() {
  // Once per page (React StrictMode replays mount effects in development).
  if (booted) return
  booted = true
  const bootStart = performance.now()
  const target = readUrlTarget()
  // Everything that can overlap does: the share lookup, the catalog, the globe's first light, the fonts.
  const shareP: Promise<Share | null> | null = target?.kind === 'share' ? getShare(target.id).catch(() => null) : null
  // A deep link computes as soon as boot ends, so its engine and time-zone table load now (the landing
  // loads them at idle).
  if (target) {
    void ensureTz()
    void loadEngine().catch(() => undefined)
  }
  startCatalog()

  await Promise.race([waitFor(() => useApp.getState().globeReady), sleep(12_000)])
  try {
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready
  } catch {
    /* ignore */
  }

  // Resolve the URL target while the boot log is still up.
  let run: { place: Place; opts: RunOpts; share?: Share } | null = null
  if (target?.kind === 'q') run = { place: target.place, opts: { selectPassId: target.passId } }
  else if (shareP) {
    const share = await raceTimeout(shareP, SHARE_CAP_MS - (performance.now() - bootStart))
    if (share) {
      const place: Place = { label: share.placeLabel, lat: share.lat, lon: share.lon, source: 'url' }
      // Centre the window on the shared pass if it is older than the default window.
      const t = share.tClosest ?? Date.now()
      const now = Date.now() - t > 6 * DAY ? t + 3.5 * DAY : Date.now()
      run = { place, opts: { now, selectNorad: share.norad, selectNear: t }, share }
    } else {
      // Unknown, expired or unreachable share: the landing, with a clean address bar.
      history.replaceState(null, '', location.pathname)
    }
  }

  if (run) {
    // Straight from boot to computing: runReport sets the phase, the curtain lifts onto the panel.
    if (run.share) useApp.getState().setShared(run.share)
    void runReport(run.place, run.opts)
    return
  }
  if (catalogFailed) {
    useApp.getState().setPhase('error', CATALOG_ERROR)
    return
  }
  useApp.getState().setPhase('idle')
  afterLandingEntrance(() => {
    void loadEngine().then(warmPassWorkers, () => undefined)
    void ensureTz()
    loadNamesWhenIdle()
  })
}

/**
 * Run `fn` in idle time once the UI's entrance animations are over (store.motionBusyUntil, written by the
 * landing as enterDelay + 1600 ms). Used to keep worker spawns and chunk fetches out of the hero entrance.
 */
export function afterLandingEntrance(fn: () => void) {
  const go = () => {
    const busy = useApp.getState().motionBusyUntil - performance.now()
    if (busy > 16) {
      setTimeout(go, busy + 32)
      return
    }
    whenIdle(fn)
  }
  // The landing mounts and writes its hold in the commit after 'idle'; look a frame later.
  setTimeout(go, 64)
}

/** Hover-label names for the off-profile objects (compact catalog), once the catalog is in. */
function loadNamesWhenIdle() {
  loadCatalog().then(
    () => whenIdle(() => void loadCatalogNames(), 4000),
    () => undefined,
  )
}

export function whenIdle(fn: () => void, timeout = 1500) {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
  if (ric) ric(fn, { timeout })
  else setTimeout(fn, 120)
}

// ───────────────────────────── reports ─────────────────────────────

export interface RunOpts {
  now?: number
  selectPassId?: string
  selectNorad?: number
  selectNear?: number
}

/** The last run, so "Try again" re-runs it without retyping. */
let lastRun: { place: Place; opts: RunOpts } | null = null

/** Re-run the last report (error notice, archive-outage headline). Falls back to the stored place. */
export function retryReport() {
  const st = useApp.getState()
  if (lastRun && (!st.place || (st.place.lat === lastRun.place.lat && st.place.lon === lastRun.place.lon))) {
    void runReport(lastRun.place, lastRun.opts)
    return
  }
  if (st.place) {
    void runReport(st.place)
    return
  }
  // Nothing to re-run (the catalog failed before any search): try the catalog again, then the landing.
  st.setPhase('boot')
  void (async () => {
    startCatalog()
    try {
      await loadCatalog()
      useApp.getState().setPhase('idle')
    } catch {
      useApp.getState().setPhase('error', CATALOG_ERROR)
    }
  })()
}

export async function runReport(place: Place, opts: RunOpts = {}) {
  inflight?.abort()
  const ctrl = new AbortController()
  inflight = ctrl
  lastRun = { place, opts }
  const s = useApp.getState()
  // A new place (inline search, not the share's own place) drops the share context.
  if (s.shared && (Math.abs(s.shared.lat - place.lat) > 0.02 || Math.abs(s.shared.lon - place.lon) > 0.02)) s.setShared(undefined)
  s.selectPass(undefined)
  s.setReport(undefined)
  s.setPlace(place)
  const end = opts.now ?? Date.now()
  s.setPendingWindow([end - 7 * DAY, end])
  s.setProgress({ stage: 'catalog', message: 'Loading orbital elements' })
  // The camera flight this search starts is the first one with an id above this.
  const flightBefore = s.cameraFlight.id
  s.setPhase('computing')
  s.setTimeMode('live')
  s.setCamera({ kind: 'place', lat: place.lat, lon: place.lon })
  writeUrl(place)
  if (place.source !== 'url') void recordLookup(place).catch(() => undefined)

  const started = performance.now()
  let finalReport: Report | undefined
  let onFinal: (() => void) | undefined
  let heroP: Promise<unknown> | undefined
  let firstShow: Promise<void> | undefined
  let shown = false

  /** The first time results appear: wait for the camera, the final report (briefly) and the hero image. */
  const showFirst = async (r: Report) => {
    mark(r.partial ? 'partial-report' : 'final-report')
    // (1) Decode the picture that will lead the panel while the camera is still flying.
    heroP ??= preloadHero(r, opts)
    // (2) Land ~1 s before the camera arrives, never sooner than 1.8 s after the search.
    await waitForCamera(started, flightBefore, ctrl.signal)
    mark('camera-window')
    if (inflight !== ctrl) return
    // (3) A partial report gets a short head start for the final one.
    if (!finalReport && r.partial) await raceTimeout(new Promise<void>((res) => (onFinal = res)), FINAL_RACE_MS)
    if (inflight !== ctrl) return
    const best = finalReport ?? r
    if (best !== r) heroP = preloadHero(best, opts) // usually the same URL: an instant cache hit
    // (4) The hero image, decoded, or at most 1.2 s more.
    await raceTimeout(heroP, HERO_RACE_MS)
    mark('hero-ready')
    if (inflight !== ctrl) return
    const st = useApp.getState()
    shown = true
    // One tick: report, preselection and phase together (the results view retargets the camera from here).
    st.setReport(finalReport ?? best)
    const pre = pickPreselect(finalReport ?? best, opts)
    if (pre) st.selectPass(pre)
    st.setPhase('results')
    mark('results')
  }

  /** Every later report (final after partial, background patches) applies at once. */
  const apply = (r: Report) => {
    if (inflight !== ctrl) return
    if (!shown) return
    const st = useApp.getState()
    if (st.report === r) return
    st.setReport(r)
    if (st.selectedPassId && !r.passes.some((p) => p.id === st.selectedPassId)) st.selectPass(undefined)
  }

  const progress = progressWriter(ctrl)
  try {
    const { computeReport } = await loadEngine()
    if (inflight !== ctrl) return
    const report = await computeReport(place, {
      now: opts.now,
      signal: ctrl.signal,
      onProgress: progress.write,
      // The archive answers ~2 s before the partial report: start the likely hero's crop now (Planetary
      // Computer renders it on demand, 1–4 s cold), so it is decoded by the time results land.
      onArchive: (caps) => {
        if (inflight === ctrl) void warmLikelyHero(caps, opts)
      },
      onPartial: (r) => {
        if (inflight !== ctrl) return
        firstShow ??= showFirst(r)
      },
      // Background verification after the final report: counts only ever go up.
      onUpdate: (r) => {
        finalReport = r
        apply(r)
      },
    })
    if (inflight !== ctrl) return
    // A report needs the catalog: if the boot-time load had failed, this one succeeded (the HUD re-reads it).
    if (!useApp.getState().catalogReady) useApp.getState().setCatalogReady(true)
    finalReport = report
    onFinal?.()
    if (firstShow) {
      await firstShow
      apply(finalReport)
    } else await showFirst(report)
    if (inflight !== ctrl) return
    progress.cancel()
    useApp.getState().setProgress({ stage: 'done', message: 'Report ready' })
    // Deep links never idle on the landing: fetch the hover names after the results entrance instead.
    afterLandingEntrance(loadNamesWhenIdle)
    if (report.archiveFailed) scheduleArchiveRetry(place, opts, ctrl)
  } catch (e) {
    progress.cancel()
    if (ctrl.signal.aborted) return
    console.error(e)
    // The place stays in the store, so "Try again" needs no input. Say what actually failed: without a
    // catalog no pass can be computed (the HUD says "catalog unavailable" too).
    useApp.getState().setPhase('error', currentCatalog() ? 'Something went wrong computing passes for this place. Try again in a moment.' : CATALOG_ERROR)
  }
}

/**
 * Sentinel-2 / Landsat archives didn't answer: try the whole report once more in the background after 8 s
 * (same window, so pass ids and the selection survive) and swap it in if the archives answered this time.
 */
function scheduleArchiveRetry(place: Place, opts: RunOpts, ctrl: AbortController) {
  const windowEnd = useApp.getState().report?.windowEnd
  const timer = setTimeout(async () => {
    if (inflight !== ctrl || ctrl.signal.aborted) return
    try {
      const { computeReport } = await loadEngine()
      const r = await computeReport(place, { now: windowEnd ?? opts.now, signal: ctrl.signal })
      if (inflight !== ctrl || r.archiveFailed || r.partial) return
      const st = useApp.getState()
      const cur = st.report
      // Only ever swap in a strictly better, final report: never fewer photographs than the user already saw
      // (a GIBS budget cut on the retry can verify fewer weather mosaics than the first run did).
      if (cur && r.counts.imaged < cur.counts.imaged) return
      st.setReport(r)
      if (st.selectedPassId && !r.passes.some((p) => p.id === st.selectedPassId)) st.selectPass(undefined)
    } catch {
      /* aborted or failed again: the headline already says so, and Try again is there */
    }
  }, ARCHIVE_RETRY_MS)
  ctrl.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
}

/**
 * Progress events can arrive many times per frame (pass workers, mosaic probes): one store write per frame.
 * Except at a stage change: the finished stage's last event is written first, so the readout's completed
 * line keeps its final words ("394 / 394", not whichever count happened to land on a frame boundary).
 */
function progressWriter(ctrl: AbortController) {
  let pending: ProgressEvent | undefined
  let raf = 0
  const flush = () => {
    raf = 0
    if (inflight === ctrl && pending) useApp.getState().setProgress(pending)
    pending = undefined
  }
  return {
    write: (e: ProgressEvent) => {
      if (inflight !== ctrl) return
      if (pending && pending.stage !== e.stage) useApp.getState().setProgress(pending)
      pending = e
      if (!raf) raf = requestAnimationFrame(flush)
    },
    /** Drop anything not yet written (a stale event must never overwrite 'done'). */
    cancel: () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      pending = undefined
    },
  }
}

/**
 * What the hero preload needs: the results' URL builders and the image loader. Loaded on first use (they are
 * in the results chunk, which a search has requested by then), so they stay out of the first bundle.
 */
const loadHeroTools = () =>
  Promise.all([import('@/ui/results/bestLook'), import('@/ui/results/lib/captures'), import('@/imagery/image')]).then(
    ([best, caps, image]) => ({ ...best, ...caps, ...image }),
  )

/**
 * Before any pass is matched: download the scene most likely to lead the panel. The shared pass's own scene
 * for a share link; otherwise the lowest scene cloud (10 % buckets), then the most recent — pickBestLook's
 * order without the spot check, which only reorders near-ties. A wrong guess costs one crop download; the
 * right one is a cache hit for preloadHero and the hero (same URL). Never rejects.
 */
async function warmLikelyHero(caps: Capture[], opts: RunOpts): Promise<void> {
  try {
    const { cropSpec, displayUrl, isDetailed, preloadImage } = await loadHeroTools()
    const detailed = caps.filter(isDetailed)
    // A preselected pass (share, or a ?p=<norad>-<minute> deep link): its own scene, the one nearest in time.
    const fromId = opts.selectPassId ? /^(\d+)-(\d+)$/.exec(opts.selectPassId) : null
    const norad = opts.selectNorad ?? (fromId ? Number(fromId[1]) : undefined)
    let pick: Capture | undefined
    if (norad !== undefined) {
      const near = opts.selectNear ?? (fromId ? Number(fromId[2]) * 60_000 : Date.now())
      pick = detailed.filter((c) => c.norad === norad).sort((a, b) => Math.abs(a.datetime - near) - Math.abs(b.datetime - near))[0]
    } else {
      const bucket = (c: Capture) => Math.floor((c.cloudCoverPct ?? 50) / 10)
      pick = [...detailed].sort((a, b) => bucket(a) - bucket(b) || b.datetime - a.datetime)[0]
    }
    if (pick) await preloadImage(displayUrl(pick, cropSpec(pick.collection))).catch(() => undefined)
  } catch (err) {
    console.error(err)
  }
}

/** The image that leads the panel: the preselected pass's (share / deep link), else the best look. Never rejects. */
async function preloadHero(r: Report, opts: RunOpts): Promise<unknown> {
  try {
    const { bestLookImageUrl, captureFor, cropSpec, displayUrl, preloadImage } = await loadHeroTools()
    let url: string | undefined
    const pre = pickPreselect(r, opts)
    const pass = pre ? r.passes.find((p) => p.id === pre) : undefined
    const capture = pass ? captureFor(r, pass) : undefined
    if (capture) url = displayUrl(capture, cropSpec(capture.collection))
    else url = bestLookImageUrl(r)
    return url ? await preloadImage(url).catch(() => undefined) : undefined
  } catch (err) {
    console.error(err)
    return undefined
  }
}

/**
 * Resolve at max(started + 1.8 s, camera eta − 1 s). The eta is re-read whenever the globe reports a
 * flight change (a retarget moves it). Only flights that started after this search count; without one
 * (reduced-motion cut, the camera already there, no globe) the 1.8 s floor applies.
 */
function waitForCamera(started: number, flightBefore: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsub = () => {}
    const finish = () => {
      clearTimeout(timer)
      unsub()
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const plan = () => {
      const f = useApp.getState().cameraFlight
      let at = started + MIN_DWELL_MS
      if (f.id > flightBefore && f.flying) at = Math.max(at, f.eta - LEAD_BEFORE_ARRIVAL_MS)
      at = Math.min(at, started + MAX_CAMERA_WAIT_MS)
      clearTimeout(timer)
      const wait = at - performance.now()
      if (wait <= 0) finish()
      else timer = setTimeout(plan, wait)
    }
    unsub = useApp.subscribe((st, prev) => {
      if (st.cameraFlight !== prev.cameraFlight) plan()
    })
    signal.addEventListener('abort', finish, { once: true })
    plan()
  })
}

function pickPreselect(report: Report, opts: RunOpts): string | undefined {
  if (opts.selectPassId && report.passes.some((p) => p.id === opts.selectPassId)) return opts.selectPassId
  if (opts.selectNorad !== undefined) {
    const near = opts.selectNear ?? report.windowEnd
    const best = report.passes
      .filter((p) => p.norad === opts.selectNorad)
      .sort((a, b) => Math.abs(a.tClosest - near) - Math.abs(b.tClosest - near))[0]
    if (best) return best.id
  }
  return undefined
}

export function resetToLanding() {
  inflight?.abort()
  inflight = null
  useApp.getState().reset()
  history.replaceState(null, '', location.pathname)
}

/**
 * Address-bar state. Coordinates are rounded to 3 decimals (~110 m): people copy the address bar far more
 * often than they press Share, and it must not leak a precise location (the share card promises ~1 km).
 */
export function writeUrl(place: Place, passId?: string) {
  const p = new URLSearchParams()
  p.set('q', `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`)
  p.set('n', place.label)
  if (passId) p.set('p', passId)
  history.replaceState(null, '', `${location.pathname}?${p.toString()}`)
}

// ───────────────────────────── helpers ─────────────────────────────

/** A User Timing mark ("overflight:<name>") for performance tooling; free when nobody reads it. */
function mark(name: string) {
  try {
    performance.mark(`overflight:${name}`)
  } catch {
    /* ignore */
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** `p`'s value, or null once `ms` has passed (never rejects). */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  if (ms <= 0) return Promise.race([p.catch(() => null), Promise.resolve(null)])
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

function waitFor(pred: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (pred()) return resolve()
    const unsub = useApp.subscribe(() => {
      if (pred()) {
        unsub()
        resolve()
      }
    })
  })
}
