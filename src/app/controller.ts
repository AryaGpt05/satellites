/**
 * App flow controller — the only place that sequences phases.
 *   boot → idle → (locating) → computing → results
 * URL state:
 *   /?q=<lat>,<lon>&n=<label>[&p=<passId>]   deep link straight to a report
 *   /?s=<shareId>                            open a shared pass
 */
import { useApp } from '@/state/store'
import type { Place, Report } from '@/types'
import { computeReport, loadCatalog, warmPassWorkers } from '@/engine'
import { getShare, recordLookup } from '@/lib/backend'

let inflight: AbortController | null = null
const DAY = 86_400_000

export async function boot() {
  const s = useApp.getState()
  try {
    await loadCatalog()
    s.setCatalogReady(true)
    // Spin up pass workers now so the first report doesn't pay their start-up cost.
    warmPassWorkers()
  } catch (e) {
    console.error(e)
    s.setPhase('error', 'Could not load the orbit catalog. Check your connection and reload.')
    return
  }
  await Promise.race([waitFor(() => useApp.getState().globeReady), sleep(12_000)])
  try {
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready
  } catch {
    /* ignore */
  }
  useApp.getState().setPhase('idle')
  await openFromUrl()
}

async function openFromUrl() {
  const params = new URLSearchParams(location.search)
  if (params.has('sandbox')) return
  const shareId = params.get('s')
  if (shareId) {
    const share = await getShare(shareId).catch(() => null)
    if (share) {
      const place: Place = { label: share.placeLabel, lat: share.lat, lon: share.lon, source: 'url' }
      // Centre the window on the shared pass if it is older than the default window.
      const t = share.tClosest ?? Date.now()
      const now = Date.now() - t > 6 * DAY ? t + 3.5 * DAY : Date.now()
      await runReport(place, { now, selectNorad: share.norad, selectNear: t })
      return
    }
  }
  const q = params.get('q')
  if (q) {
    const [lat, lon] = q.split(',').map(Number)
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      const label = params.get('n') || `${lat.toFixed(3)}, ${lon.toFixed(3)}`
      await runReport({ label, lat, lon, source: 'url' }, { selectPassId: params.get('p') ?? undefined })
    }
  }
}

export interface RunOpts {
  now?: number
  selectPassId?: string
  selectNorad?: number
  selectNear?: number
}

export async function runReport(place: Place, opts: RunOpts = {}) {
  inflight?.abort()
  const ctrl = new AbortController()
  inflight = ctrl
  const s = useApp.getState()
  s.selectPass(undefined)
  s.setReport(undefined)
  s.setPlace(place)
  s.setProgress({ stage: 'catalog', message: 'Loading orbital elements' })
  s.setPhase('computing')
  s.setTimeMode('live')
  s.setCamera({ kind: 'place', lat: place.lat, lon: place.lon })
  writeUrl(place)
  if (place.source !== 'url') void recordLookup(place).catch(() => undefined)

  const started = performance.now()
  // Results are shown as soon as the partial report lands (passes + Sentinel-2/Landsat matches, ~1 s),
  // then replaced by the final report once NASA weather mosaics are verified. A minimum dwell lets the
  // camera arrive and the readout breathe, so it never feels instant-but-janky.
  let finalApplied = false
  let shown = false
  const show = async (r: Report, isFinal: boolean) => {
    const wait = 1800 - (performance.now() - started)
    if (wait > 0) await sleep(wait)
    if (inflight !== ctrl) return
    if (!isFinal && finalApplied) return
    if (isFinal) finalApplied = true
    const st = useApp.getState()
    st.setReport(r)
    if (!shown) {
      shown = true
      st.setPhase('results')
      const pre = pickPreselect(r, opts)
      if (pre) st.selectPass(pre)
    } else if (st.selectedPassId && !r.passes.some((p) => p.id === st.selectedPassId)) {
      st.selectPass(undefined)
    }
  }
  try {
    const report = await computeReport(place, {
      now: opts.now,
      signal: ctrl.signal,
      onProgress: (e) => {
        if (inflight === ctrl) useApp.getState().setProgress(e)
      },
      onPartial: (r) => void show(r, false),
    })
    if (inflight !== ctrl) return
    await show(report, true)
    if (inflight === ctrl) useApp.getState().setProgress({ stage: 'done', message: 'Report ready' })
  } catch (e) {
    if (ctrl.signal.aborted) return
    console.error(e)
    useApp.getState().setPhase('error', 'Something went wrong computing passes for this place. Try again in a moment.')
  }
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

export function writeUrl(place: Place, passId?: string) {
  const p = new URLSearchParams()
  p.set('q', `${place.lat.toFixed(4)},${place.lon.toFixed(4)}`)
  p.set('n', place.label)
  if (passId) p.set('p', passId)
  history.replaceState(null, '', `${location.pathname}?${p.toString()}`)
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
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
