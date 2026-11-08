/**
 * Globe sandbox: ?sandbox=globe
 *
 * Full-screen <GlobeCanvas/> driven through the real store, with a small debug bar: camera intents, a REAL
 * pass (engine computeReport for the chosen place: real catalog, SGP4, STAC + GIBS archives), replay, and
 * time-of-day offsets to check the terminator. Never imported by production code.
 *
 * URL presets (for screenshots): &view=overview|place|pass|sat  &place=waterloo|tokyo|lagos|...
 *   &t=<ISO time> (scrub to that instant)  &dt=<hours offset from now>  &replay=<rate>  &lead=<s before closest>
 *   &later=<hours> (shift time 2 s after load: the overview framing is set from the sun at boot, so this turns
 *   the night side toward the camera)
 *   &ambient=0  &hover=<norad>  &bar=0 (hide the bar)  &cat=<category>  &verdict=<verdict> (pass choice)
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { computeReport, getSatInfo, loadCatalog } from '@/engine'
import { GlobeCanvas } from '@/globe'
import { useApp } from '@/state/store'
import type { Pass, Place, Report } from '@/types'
import { Button, Label, fmtUtc } from '@/ui/system'

const PLACES: Record<string, Place> = {
  waterloo: { label: 'Waterloo', sublabel: 'Ontario, Canada', lat: 43.4723, lon: -80.5449, countryCode: 'ca', source: 'demo' },
  tokyo: { label: 'Tokyo', sublabel: 'Japan', lat: 35.6762, lon: 139.6503, countryCode: 'jp', source: 'demo' },
  lagos: { label: 'Lagos', sublabel: 'Nigeria', lat: 6.5244, lon: 3.3792, countryCode: 'ng', source: 'demo' },
  paris: { label: 'Paris', sublabel: 'France', lat: 48.8566, lon: 2.3522, countryCode: 'fr', source: 'demo' },
}

const H = 3_600_000
const params = new URLSearchParams(location.search)
/** URL presets apply once per page load (StrictMode runs mount effects twice in development). */
let presetsApplied = false

/**
 * Best pass to show off the overlay: an imaged one (most recent), else likely, else could. `&cat=` prefers a
 * category (e.g. open-optical) and `&verdict=` forces a verdict, for repeatable screenshots.
 */
function pickPass(r: Report): Pass | undefined {
  const cat = params.get('cat')
  const forced = params.get('verdict') as Pass['verdict'] | null
  const order: Pass['verdict'][] = forced ? [forced] : ['imaged', 'likely', 'could', 'overhead']
  const pool = cat ? r.passes.filter((p) => getSatInfo(p.norad)?.category === cat) : r.passes
  for (const v of order) {
    const list = (pool.length ? pool : r.passes).filter((p) => p.verdict === v).sort((a, b) => b.tClosest - a.tClosest)
    if (list.length) return list[0]
  }
  return undefined
}

export default function GlobeSandbox() {
  const st = useApp()
  const [status, setStatus] = useState('')
  const [fps, setFps] = useState(0)
  const ctrl = useRef<AbortController | null>(null)
  const showBar = params.get('bar') !== '0'

  // FPS meter (rAF cadence: measures the whole page, which is the globe).
  useEffect(() => {
    let raf = 0
    let frames = 0
    let last = performance.now()
    const tick = (now: number) => {
      frames++
      if (now - last >= 1000) {
        const v = (frames * 1000) / (now - last)
        setFps(v)
        ;(window as Window & { __fps?: number }).__fps = v
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const goOverview = useCallback(() => {
    const s = useApp.getState()
    s.selectPass(undefined)
    s.setCamera({ kind: 'overview' })
    s.setPhase('idle')
  }, [])

  const goPlace = useCallback((p: Place) => {
    const s = useApp.getState()
    s.selectPass(undefined)
    s.setReport(undefined)
    s.setPlace(p)
    s.setCamera({ kind: 'place', lat: p.lat, lon: p.lon })
    s.setPhase('results')
  }, [])

  const runPass = useCallback(async (p: Place, opts: { rate?: number; leadS?: number; sat?: boolean } = {}) => {
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    goPlace(p)
    setStatus(`COMPUTING ${p.label.toUpperCase()}…`)
    try {
      const t0 = performance.now()
      const report = await computeReport(p, { signal: c.signal, onProgress: (e) => setStatus(e.message.toUpperCase()) })
      if (c.signal.aborted) return
      const pass = pickPass(report)
      const s = useApp.getState()
      s.setReport(report)
      if (!pass) {
        setStatus('NO PASSES')
        return
      }
      s.selectPass(pass.id)
      s.setCamera(opts.sat ? { kind: 'satellite', norad: pass.norad } : { kind: 'pass', passId: pass.id })
      s.setSimTime(pass.tClosest - (opts.leadS ?? 150) * 1000)
      s.setReplayRate(opts.rate ?? 30)
      s.setTimeMode('replay')
      setStatus(
        `${report.passes.length} PASSES · ${report.counts.imaged} IMAGED · ${Math.round(performance.now() - t0)} MS · ${pass.verdict.toUpperCase()} ${pass.norad}`,
      )
    } catch (e) {
      if (!c.signal.aborted) setStatus(`ERROR ${(e as Error).message}`)
    }
  }, [goPlace])

  const shiftTime = (hours: number) => {
    const s = useApp.getState()
    s.setTimeMode('scrub')
    s.setSimTime(s.simTime + hours * H)
  }
  const togglePlay = () => {
    const s = useApp.getState()
    s.setTimeMode(s.timeMode === 'replay' ? 'scrub' : 'replay')
  }

  // URL presets.
  useEffect(() => {
    if (presetsApplied) return
    presetsApplied = true
    const s = useApp.getState()
    loadCatalog().then(
      () => s.setCatalogReady(true),
      () => setStatus('CATALOG UNAVAILABLE'),
    )
    s.setPhase('idle')
    const t = params.get('t')
    const dt = params.get('dt')
    if (t || dt) {
      s.setTimeMode('scrub')
      s.setSimTime(t ? Date.parse(t) : Date.now() + Number(dt) * H)
    }
    const later = params.get('later')
    if (later)
      window.setTimeout(() => {
        const s2 = useApp.getState()
        s2.setTimeMode('scrub')
        s2.setSimTime(s2.simTime + Number(later) * H)
      }, 2000)
    if (params.get('ambient') === '0') useApp.setState({ showAmbient: false })
    const hover = params.get('hover')
    if (hover) s.setHoveredNorad(Number(hover))
    const place = PLACES[params.get('place') ?? 'waterloo'] ?? PLACES.waterloo
    const view = params.get('view')
    if (view === 'place') goPlace(place)
    if (view === 'pass' || view === 'sat')
      void runPass(place, {
        rate: params.has('replay') ? Number(params.get('replay')) : undefined,
        leadS: params.has('lead') ? Number(params.get('lead')) : undefined,
        sat: view === 'sat',
      })
  }, [goPlace, runPass])

  const pass = st.report?.passes.find((p) => p.id === st.selectedPassId)

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--ink-0)' }}>
      <GlobeCanvas />
      {showBar && (
        <div
          style={{
            position: 'absolute',
            left: 'var(--bezel-inset)',
            right: 'var(--bezel-inset)',
            bottom: 'var(--bezel-inset)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
            padding: 10,
            background: 'var(--ink-1)',
            borderTop: '1px solid var(--line)',
            zIndex: 20,
          }}
        >
          <Label>Globe</Label>
          <Button size="sm" onClick={goOverview}>Overview</Button>
          <Button size="sm" onClick={() => goPlace(PLACES.waterloo)}>Waterloo</Button>
          <Button size="sm" onClick={() => goPlace(PLACES.tokyo)}>Tokyo</Button>
          <Button size="sm" variant="primary" onClick={() => void runPass(st.place ?? PLACES.waterloo)}>
            Real pass
          </Button>
          <Button size="sm" onClick={togglePlay} disabled={!pass}>{st.timeMode === 'replay' ? 'Pause' : 'Play'}</Button>
          <Button size="sm" onClick={() => pass && useApp.getState().setCamera({ kind: 'satellite', norad: pass.norad })} disabled={!pass}>
            Chase
          </Button>
          <Button size="sm" onClick={() => pass && useApp.getState().setCamera({ kind: 'pass', passId: pass.id })} disabled={!pass}>
            Frame pass
          </Button>
          <Button size="sm" onClick={() => shiftTime(-6)}>−6 h</Button>
          <Button size="sm" onClick={() => shiftTime(6)}>+6 h</Button>
          <Button size="sm" onClick={() => useApp.getState().setTimeMode('live')}>Live</Button>
          <Button size="sm" onClick={() => useApp.setState({ showAmbient: !st.showAmbient })}>
            Ambient {st.showAmbient ? 'on' : 'off'}
          </Button>
          <span className="t-mono t-dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
            {fmtUtc(st.simTime)} UTC · {st.timeMode.toUpperCase()} · {st.camera.kind.toUpperCase()} · {fps.toFixed(0)} FPS
            {status ? ` · ${status}` : ''}
          </span>
        </div>
      )}
    </div>
  )
}
