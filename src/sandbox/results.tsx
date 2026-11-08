/**
 * ui-results sandbox: ?sandbox=results   (never imported by production code)
 *
 * Renders <ComputingReadout/>, <ResultsView/> and <ShareSheet/> over the real globe + HUD, driven by
 * either the real-scale Waterloo fixture (default) or the REAL engine (computeReport for Waterloo).
 *
 * URL params
 *   state=computing|results|pass|share   start state (default results)
 *   source=fixture|live                  fixture report, or run the real computeReport (default fixture)
 *   pass=<id>|imaged|likely|could|overhead|mosaic   which pass to select for state=pass|share
 *   hold=1          computing: freeze the simulated progress mid-way (screenshots)
 *   globe=0         skip the 3D globe (a sandbox clock drives replay instead)
 *   hud=0           hide the HUD           chrome=0   hide the sandbox toolbar
 *   variant=zero    no photographs (imaged → likely, captures dropped): the honest zero headline
 *   variant=empty   no passes at all          variant=broken   image renders fail (error + retry state)
 */
import { Component, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { computeReport, loadCatalog } from '@/engine'
import { useApp } from '@/state/store'
import type { Pass, ProgressEvent, Report } from '@/types'
import { clearPass, ComputingReadout, focusPass, ResultsView } from '@/ui/results'
import { WATERLOO, waterlooReport } from '@/ui/results/__fixtures__/waterloo'
import { ShareSheet } from '@/ui/share'

type GlobeMod = { GlobeCanvas?: ComponentType<{ className?: string }> }
type HudMod = { Hud?: ComponentType<{ onAbout?: () => void }> }
const globeLoader = Object.values(import.meta.glob<GlobeMod>('../globe/index.ts'))[0]
const hudLoader = Object.values(import.meta.glob<HudMod>('../ui/hud/index.ts'))[0]

const params = new URLSearchParams(location.search)
const STATE = params.get('state') ?? 'results'
const SOURCE = params.get('source') ?? 'fixture'
const PICK = params.get('pass') ?? 'imaged'
const HOLD = params.get('hold') === '1'
const CHROME = params.get('chrome') !== '0'
const VARIANT = params.get('variant') ?? ''
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let booted = false
// Probe hook for the screenshot scripts (sandbox only).
;(window as unknown as { __app: typeof useApp }).__app = useApp

export default function ResultsSandbox() {
  const phase = useApp((s) => s.phase)
  const [Globe, setGlobe] = useState<GlobeMod['GlobeCanvas'] | null>(null)
  const [Hud, setHud] = useState<HudMod['Hud'] | null>(null)
  const [share, setShare] = useState<{ pass: Pass; report: Report } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (globeLoader && params.get('globe') !== '0')
      globeLoader()
        .then((m) => m.GlobeCanvas && setGlobe(() => m.GlobeCanvas!))
        .catch((e) => console.warn('[results sandbox] globe unavailable', e))
    if (hudLoader && params.get('hud') !== '0')
      hudLoader()
        .then((m) => m.Hud && setHud(() => m.Hud!))
        .catch((e) => console.warn('[results sandbox] hud unavailable', e))
  }, [])

  // Boot straight into the requested state (once: StrictMode runs effects twice in dev).
  useEffect(() => {
    if (booted) return
    booted = true
    void (async () => {
      await loadCatalog().catch(() => undefined)
      useApp.getState().setCatalogReady(true)
      if (STATE === 'computing') return simulateComputing()
      if (SOURCE === 'live') return runLive()
      const report = await openFixture()
      if (STATE === 'pass' || STATE === 'share') {
        const p = pickPass(report, PICK)
        if (p) {
          focusPass(p)
          if (STATE === 'share') setShare({ pass: p, report })
        }
      }
    })()
  }, [])

  // App-like Esc: deselect, then back to search. (The share sheet captures its own Esc.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const st = useApp.getState()
      if (st.selectedPassId) clearPass()
      else if (st.phase === 'results' || st.phase === 'computing') st.reset()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--ink-0)', overflow: 'hidden' }}>
      {Globe ? (
        <SceneBoundary>
          <Globe />
        </SceneBoundary>
      ) : (
        <SandboxClock />
      )}
      {Hud ? <Hud /> : null}
      {phase === 'computing' && <ComputingReadout />}
      {phase === 'results' && <ResultsView />}
      {phase === 'idle' && (
        <div className="t-label" style={{ position: 'fixed', left: 48, top: '45%', display: 'grid', gap: 12 }}>
          <span>Sandbox · idle (store.reset() was called)</span>
          <span style={{ color: 'var(--bone-2)' }}>Use the toolbar to run the fixture or the real engine.</span>
        </div>
      )}
      {share ? <ShareSheet pass={share.pass} report={share.report} onClose={() => setShare(null)} /> : null}
      {CHROME ? (
        <div style={toolbar}>
          <span style={{ color: 'var(--bone-3)' }}>Sandbox</span>
          <button style={btn} disabled={busy} onClick={() => run(simulateComputing)}>
            Computing
          </button>
          <button style={btn} disabled={busy} onClick={() => run(openFixture)}>
            Fixture
          </button>
          <button style={btn} disabled={busy} onClick={() => run(runLive)}>
            Real engine
          </button>
          <button
            style={btn}
            onClick={() => {
              const st = useApp.getState()
              const p = st.report?.passes.find((x) => x.id === st.selectedPassId)
              if (p && st.report) setShare({ pass: p, report: st.report })
            }}
          >
            Share selected
          </button>
        </div>
      ) : null}
    </div>
  )
}

// ── drivers ───────────────────────────────────────────────────────────────────────────────

/** Degrade the fixture to exercise empty / zero / failure states. */
function applyVariant(r: Report): Report {
  switch (VARIANT) {
    case 'zero': {
      const passes = r.passes.map((p) => (p.verdict === 'imaged' ? { ...p, verdict: 'likely' as const, captureId: undefined } : p))
      const counts = { ...r.counts, likely: r.counts.likely + r.counts.imaged, imaged: 0 }
      return { ...r, passes, captures: [], counts }
    }
    case 'empty':
      return { ...r, passes: [], captures: [], geo: [], counts: { ...r.counts, passes: 0, imaged: 0, likely: 0, could: 0, overhead: 0 } }
    case 'broken':
      return { ...r, captures: r.captures.map((c) => ({ ...c, cropUrl: () => 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/0,0,0,0/8x8.jpg?collection=none&item=none' })) }
  }
  return r
}

async function openFixture(): Promise<Report> {
  const st = useApp.getState()
  const report = applyVariant(await waterlooReport())
  st.selectPass(undefined)
  st.setPlace(report.place)
  st.setReport(report)
  st.setTimeMode('live')
  st.setCamera({ kind: 'place', lat: report.place.lat, lon: report.place.lon })
  st.setPhase('results')
  return report
}

/** The real engine, like the app controller (partial report first, then the final one). */
async function runLive() {
  const st = useApp.getState()
  st.selectPass(undefined)
  st.setReport(undefined)
  st.setPlace(WATERLOO)
  st.setProgress({ stage: 'catalog', message: 'Loading orbital elements' })
  st.setPhase('computing')
  st.setTimeMode('live')
  st.setCamera({ kind: 'place', lat: WATERLOO.lat, lon: WATERLOO.lon })
  const t0 = performance.now()
  const show = async (r: Report) => {
    const wait = 1800 - (performance.now() - t0)
    if (wait > 0) await sleep(wait)
    useApp.getState().setReport(r)
    if (useApp.getState().phase === 'computing') useApp.getState().setPhase('results')
  }
  try {
    const final = await computeReport(WATERLOO, {
      onProgress: (e) => useApp.getState().setProgress(e),
      onPartial: (r) => void show(r),
    })
    console.info('[results sandbox] real report', final.counts, final.timings, final.notes)
    await show(final)
  } catch (e) {
    console.error(e)
    useApp.getState().setPhase('error', String(e))
  }
}

/** Replays a realistic progress sequence (timings from real engine runs). */
async function simulateComputing() {
  const st = useApp.getState()
  st.selectPass(undefined)
  st.setReport(undefined)
  st.setPlace(WATERLOO)
  st.setTimeMode('live')
  st.setCamera({ kind: 'place', lat: WATERLOO.lat, lon: WATERLOO.lon })
  st.setPhase('computing')
  const steps: [number, ProgressEvent][] = [
    [0, { stage: 'catalog', message: 'LOADING ORBITAL CATALOG', fraction: 0.02 }],
    [180, { stage: 'catalog', message: 'CATALOG · 16,912 OBJECTS', fraction: 0.06 }],
    [60, { stage: 'propagate', message: 'PROPAGATING 403 ORBITS · 7 DAYS', fraction: 0.06 }],
    [140, { stage: 'propagate', message: 'PROPAGATING ORBITS · 96 / 403', fraction: 0.21 }],
    [140, { stage: 'propagate', message: 'PROPAGATING ORBITS · 211 / 403', fraction: 0.39 }],
    [140, { stage: 'propagate', message: 'PROPAGATING ORBITS · 288 / 403', fraction: 0.52 }],
  ]
  const tail: [number, ProgressEvent][] = [
    [160, { stage: 'propagate', message: 'PROPAGATING ORBITS · 403 / 403', fraction: 0.7 }],
    [40, { stage: 'archive', message: 'SEARCHING SENTINEL-2 + LANDSAT ARCHIVES', fraction: 0.72 }],
    [620, { stage: 'match', message: 'MATCHING 5 SCENES TO 1,883 PASSES', fraction: 0.8 }],
    [80, { stage: 'match', message: 'VERIFYING NASA WEATHER MOSAICS', fraction: 0.86 }],
  ]
  for (const [ms, e] of HOLD ? steps : [...steps, ...tail]) {
    await sleep(ms)
    if (useApp.getState().phase !== 'computing') return
    useApp.getState().setProgress(e)
  }
  if (HOLD) return
  await sleep(600)
  if (useApp.getState().phase !== 'computing') return
  await openFixture()
}

function pickPass(report: Report, pick: string): Pass | undefined {
  const byId = report.passes.find((p) => p.id === pick)
  if (byId) return byId
  const mosaic = (p: Pass) => !!p.captureId && p.captureId.includes('@')
  const newest = (ps: Pass[]) => ps.sort((a, b) => b.tClosest - a.tClosest)[0]
  switch (pick) {
    case 'imaged':
      // The headline image: the newest detailed (Sentinel-2 / Landsat) photograph.
      return newest(report.passes.filter((p) => p.verdict === 'imaged' && !mosaic(p)))
    case 'mosaic':
      return newest(report.passes.filter(mosaic))
    case 'likely':
    case 'could':
    case 'overhead':
      return [...report.passes].filter((p) => p.verdict === pick).sort((a, b) => a.offNadirDeg - b.offNadirDeg)[0]
  }
  return undefined
}

/** Without the globe, advance replay time here (the globe's Clock does this in the app). */
function SandboxClock() {
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let acc = 0
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const st = useApp.getState()
      if (st.timeMode === 'replay') {
        acc += dt
        if (acc >= 0.1) {
          st.setSimTime(st.simTime + st.replayRate * acc * 1000)
          acc = 0
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return null
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <SandboxClock /> : this.props.children
  }
}

const toolbar: React.CSSProperties = {
  position: 'fixed',
  top: 14,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 100,
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  padding: '4px 8px',
  background: 'var(--ink-1)',
  border: '1px dashed var(--bone-4)',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}
const btn: React.CSSProperties = { padding: '3px 6px', border: '1px solid var(--line-strong)', color: 'var(--bone-2)' }
