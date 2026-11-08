/**
 * ui-shell sandbox: ?sandbox=shell   (never imported by production code)
 *
 * Renders the HUD, BootScreen → Landing and the About page over the real <GlobeCanvas/> when
 * src/globe exports it, otherwise over a sandbox-only stand-in: an orthographic projection of the
 * real day/night textures lit by the real sun (no catalog points), drawn once on a 2D canvas.
 *
 * Boot is driven like the app controller: real loadCatalog(), real texture loads, fonts.ready.
 *
 * URL params
 *   phase=boot|idle|locating|computing|results   start phase (default boot)
 *   about=1          open the About page          sheet=1   show the Sheet demo (fixture content)
 *   slow=1           delay catalog / textures by 2.4 s / 4.2 s to watch the boot log
 *   globe=0          force the stand-in            chrome=0  hide the sandbox toolbar
 *   q=<text>         prefill + run a search (for screenshots of the suggestion list)
 */
import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { loadCatalog } from '@/engine'
import { latLonToWorld, subsolarPoint, sunDirectionWorld } from '@/lib/geo'
import { useApp, type Phase } from '@/state/store'
import type { Place } from '@/types'
import { Hud } from '@/ui/hud'
import { BootScreen, Landing } from '@/ui/landing'
import { AboutPage } from '@/ui/pages'
import { Button, Glyph, Readout, Rule, Sheet, Tag, fmtLat, fmtLon, useIsMobile } from '@/ui/system'

type GlobeMod = { GlobeCanvas?: ComponentType<{ className?: string }> }
const globeLoader = Object.values(import.meta.glob<GlobeMod>('../globe/index.ts'))[0]

const params = new URLSearchParams(location.search)
const START_PHASE = (params.get('phase') as Phase | null) ?? 'boot'
const SLOW = params.get('slow') === '1'
const CHROME = params.get('chrome') !== '0'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default function ShellSandbox() {
  const phase = useApp((s) => s.phase)
  const [about, setAbout] = useState(params.get('about') === '1')
  const [sheet, setSheet] = useState(params.get('sheet') === '1' || START_PHASE === 'results')
  const [submitted, setSubmitted] = useState<Place | null>(null)
  const [Globe, setGlobe] = useState<GlobeMod['GlobeCanvas'] | null>(null)
  const [globeTried, setGlobeTried] = useState(false)

  // Try the real globe first.
  useEffect(() => {
    if (!globeLoader || params.get('globe') === '0') return setGlobeTried(true)
    globeLoader()
      .then((m) => m.GlobeCanvas && setGlobe(() => m.GlobeCanvas!))
      .catch((e) => console.warn('[shell sandbox] globe module failed to load; using stand-in', e))
      .finally(() => setGlobeTried(true))
  }, [])

  // Boot like the controller does.
  useEffect(() => {
    const app = useApp.getState()
    let alive = true
    void (async () => {
      const catalog = (SLOW ? sleep(2400) : Promise.resolve()).then(() => loadCatalog())
      if (START_PHASE !== 'boot') {
        await catalog.catch(() => undefined)
        if (!alive) return
        app.setCatalogReady(true)
        app.setPhase(START_PHASE)
        return
      }
      app.setPhase('boot')
      try {
        await catalog
        if (alive) useApp.getState().setCatalogReady(true)
      } catch {
        if (alive) useApp.getState().setPhase('error', 'Could not load the orbit catalog.')
        return
      }
      await Promise.race([waitFor(() => useApp.getState().globeReady), sleep(12_000)])
      await document.fonts?.ready
      if (alive && useApp.getState().phase === 'boot') useApp.getState().setPhase('idle')
    })()
    return () => {
      alive = false
    }
  }, [])

  // Global keys like the app: "?" toggles About.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea')
      if (!typing && e.key === '?') setAbout((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Prefill a query for screenshots of the suggestion list.
  useEffect(() => {
    const q = params.get('q')
    if (!q || (phase !== 'idle' && phase !== 'locating')) return
    const t = setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')
      if (!input) return
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, q)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, 1600)
    return () => clearTimeout(t)
  }, [phase])

  const go = (p: Phase) => {
    const app = useApp.getState()
    if (p === 'boot') {
      app.setGlobeReady(false)
      app.setCatalogReady(false)
      app.setPhase('boot')
      // re-run a (cached, so quick) boot
      void (async () => {
        await sleep(SLOW ? 2400 : 300)
        await loadCatalog()
        useApp.getState().setCatalogReady(true)
        await sleep(SLOW ? 1800 : 400)
        useApp.getState().setGlobeReady(true)
        await document.fonts?.ready
        await sleep(200)
        if (useApp.getState().phase === 'boot') useApp.getState().setPhase('idle')
      })()
      return
    }
    app.setPhase(p)
  }

  const onSubmit = (place: Place) => {
    setSubmitted(place)
    useApp.getState().setPlace(place)
    useApp.getState().setPhase('computing')
  }

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: 'var(--ink-0)' }}>
      {Globe ? (
        <GlobeBoundary fallback={<StandInGlobe />}>
          <Globe className="sbx-scene" />
        </GlobeBoundary>
      ) : globeTried ? (
        <StandInGlobe />
      ) : null}

      {/* app layer, as in src/app/Main.tsx */}
      <div className="sbx-layer" style={{ position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none' }}>
        {(phase === 'idle' || phase === 'locating') && <Landing onSubmit={onSubmit} />}
        {phase === 'computing' && <ComputingStub place={submitted} onBack={() => go('idle')} />}
        {sheet && <SheetDemo onClose={() => setSheet(false)} />}
      </div>

      <Hud onAbout={() => setAbout(true)} />
      {phase === 'boot' && <BootScreen />}
      {about && <AboutPage onClose={() => setAbout(false)} />}
      {CHROME ? <Toolbar phase={phase} go={go} about={about} setAbout={setAbout} sheet={sheet} setSheet={setSheet} submitted={submitted} /> : null}
      <style>{`.sbx-scene{position:absolute;inset:0;z-index:0}.sbx-layer>*{pointer-events:auto}`}</style>
    </div>
  )
}

// ── sandbox chrome ─────────────────────────────────────────────────────────────────────────

function Toolbar(props: {
  phase: Phase
  go: (p: Phase) => void
  about: boolean
  setAbout: (v: boolean) => void
  sheet: boolean
  setSheet: (v: boolean) => void
  submitted: Place | null
}) {
  const mobile = useIsMobile()
  const [open, setOpen] = useState(!mobile)
  const phases: Phase[] = ['boot', 'idle', 'locating', 'computing', 'results']
  return (
    <div
      style={{
        position: 'fixed',
        zIndex: 100,
        left: '50%',
        top: mobile ? 'auto' : 'calc(var(--bezel-inset) + 10px)',
        bottom: mobile ? 6 : 'auto',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        padding: 4,
        background: 'var(--ink-1)',
        border: '1px dashed var(--line-strong)',
        maxWidth: 'calc(100vw - 24px)',
        flexWrap: 'wrap',
        justifyContent: 'center',
      }}
    >
      <Tag>Sandbox</Tag>
      {open ? (
        <>
          {phases.map((p) => (
            <Button key={p} size="sm" variant={props.phase === p ? 'primary' : 'secondary'} onClick={() => props.go(p)}>
              {p}
            </Button>
          ))}
          <Button size="sm" variant={props.about ? 'primary' : 'secondary'} onClick={() => props.setAbout(!props.about)}>
            About
          </Button>
          <Button size="sm" variant={props.sheet ? 'primary' : 'secondary'} onClick={() => props.setSheet(!props.sheet)}>
            Sheet
          </Button>
          {props.submitted ? (
            <span className="t-label" style={{ padding: '0 8px' }}>
              → {props.submitted.label} {props.submitted.lat.toFixed(3)},{props.submitted.lon.toFixed(3)}
            </span>
          ) : null}
        </>
      ) : null}
      {mobile ? (
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      ) : null}
    </div>
  )
}

function ComputingStub({ place, onBack }: { place: Place | null; onBack: () => void }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 'calc(var(--bezel-inset) + var(--margin))',
        bottom: 'calc(var(--bezel-inset) + 96px)',
        display: 'grid',
        gap: 12,
        pointerEvents: 'auto',
      }}
    >
      <Rule index="SBX">ComputingReadout belongs to ui-results</Rule>
      <span className="t-mono">{place ? `${place.label} · ${fmtLat(place.lat)} ${fmtLon(place.lon)} · ${place.source}` : '—'}</span>
      <div>
        <Button size="sm" onClick={onBack}>
          <Glyph name="arrow-left" size={14} /> Back to landing
        </Button>
      </div>
    </div>
  )
}

/** Sheet demo with FIXTURE rows, to exercise the container (dock, snaps, scroll, footer). */
function SheetDemo({ onClose }: { onClose: () => void }) {
  const rows = Array.from({ length: 18 }, (_, i) => i)
  return (
    <Sheet
      label="Sheet demo"
      onClose={onClose}
      header={
        <div style={{ display: 'grid', gap: 8 }}>
          <Rule index="SBX">Sheet demo · fixture content</Rule>
          <div className="t-h2">Waterloo</div>
        </div>
      }
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" size="sm">
            <Glyph name="share" size={14} /> Primary
          </Button>
          <Button size="sm">Secondary</Button>
        </div>
      }
    >
      <div style={{ display: 'grid', gap: 0 }}>
        {rows.map((i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
            <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <Glyph name={i % 3 === 0 ? 'imaged' : i % 3 === 1 ? 'likely' : 'commercial'} size={14} color={i % 3 === 0 ? 'var(--signal)' : undefined} />
              Fixture row {String(i + 1).padStart(2, '0')}
            </span>
            <Readout label="" value={`${(12 + i * 1.7).toFixed(1)}`} unit="KM" />
          </div>
        ))}
      </div>
    </Sheet>
  )
}

// ── stand-in globe (sandbox only) ──────────────────────────────────────────────────────────

class GlobeBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    console.warn('[shell sandbox] GlobeCanvas crashed; using stand-in', e)
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`failed: ${src}`))
    img.src = src
  })
}

function pixels(img: HTMLImageElement) {
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(img, 0, 0)
  return { w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data }
}

/**
 * Orthographic Earth from the real textures, lit by the real sun, framed where the landing expects
 * the globe: right half on desktop, upper area on phones.
 */
function StandInGlobe() {
  const ref = useRef<HTMLCanvasElement>(null)
  const mobile = useIsMobile()
  useEffect(() => {
    let alive = true
    const canvas = ref.current
    if (!canvas) return
    void (async () => {
      const [dayImg, nightImg] = await Promise.all([
        (SLOW ? sleep(4200) : Promise.resolve()).then(() => loadImage('/textures/earth-day-1k.webp')),
        loadImage('/textures/earth-night-1k.webp'),
      ])
      if (!alive) return
      const day = pixels(dayImg)
      const night = pixels(nightImg)
      const W = window.innerWidth
      const H = window.innerHeight
      canvas.width = W
      canvas.height = H
      const g = canvas.getContext('2d')!
      const r = mobile ? W * 0.44 : Math.min(H * 0.43, W * 0.3)
      const cx = mobile ? W * 0.5 : W * 0.7
      const cy = mobile ? H * 0.27 : H * 0.5
      const now = Date.now()
      const sun = sunDirectionWorld(now)
      const ss = subsolarPoint(now)
      // Look a little west of the sub-solar point so the terminator crosses the disc.
      const f = latLonToWorld(18, ss.lon - 62)
      const e = latLonToWorld(0, ss.lon - 62 + 90).setY(0).normalize()
      const n = f.clone().cross(e).normalize()
      const size = Math.ceil(r * 2)
      const img = g.createImageData(size, size)
      const out = img.data
      for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
          const x = (px + 0.5 - r) / r
          const y = (r - py - 0.5) / r
          const rr = x * x + y * y
          if (rr > 1) continue
          const z = Math.sqrt(1 - rr)
          const wx = x * e.x + y * n.x + z * f.x
          const wy = x * e.y + y * n.y + z * f.y
          const wz = x * e.z + y * n.z + z * f.z
          const lat = Math.asin(Math.max(-1, Math.min(1, wy)))
          const lon = Math.atan2(-wz, wx)
          const u = Math.min(day.w - 1, Math.floor(((lon / Math.PI + 1) / 2) * day.w))
          const v = Math.min(day.h - 1, Math.floor((0.5 - lat / Math.PI) * day.h))
          const di = (v * day.w + u) * 4
          const nu = Math.min(night.w - 1, Math.floor((u / day.w) * night.w))
          const nv = Math.min(night.h - 1, Math.floor((v / day.h) * night.h))
          const ni = (nv * night.w + nu) * 4
          const cosSun = wx * sun.x + wy * sun.y + wz * sun.z
          const t = Math.max(0, Math.min(1, (cosSun + 0.08) / 0.22))
          const lit = Math.pow(Math.max(0, cosSun), 0.6) * 0.92 + 0.04
          const limb = 0.55 + 0.45 * Math.pow(z, 0.5)
          const o = (py * size + px) * 4
          for (let k = 0; k < 3; k++) {
            const dayV = day.d[di + k] * lit * 0.94
            const nightV = night.d[ni + k] * [1.0, 0.68, 0.4][k] * 0.9
            out[o + k] = (dayV * t + nightV * (1 - t)) * limb
          }
          out[o + 3] = 255
        }
      }
      g.clearRect(0, 0, W, H)
      g.putImageData(img, Math.round(cx - r), Math.round(cy - r))
      // thin atmosphere rim
      g.beginPath()
      g.arc(cx, cy, r + 0.5, 0, Math.PI * 2)
      g.strokeStyle = 'rgba(158, 195, 255, 0.28)'
      g.lineWidth = 1.5
      g.stroke()
      useApp.getState().setGlobeReady(true)
    })().catch((err) => console.warn('[shell sandbox] stand-in failed', err))
    return () => {
      alive = false
    }
  }, [mobile])
  return <canvas ref={ref} aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 0 }} />
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
