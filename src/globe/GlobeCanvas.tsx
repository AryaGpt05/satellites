/**
 * <GlobeCanvas/>: the full-bleed 3D scene. Reads the store; writes only `globeReady`, `hoveredNorad`, the
 * throttled `simTime` of the clock it owns (see Clock.tsx) and `cameraFlight` (CameraDirector, on transitions).
 * See docs/ARCHITECTURE.md ("globe") and docs/DESIGN.md §6.
 *
 * Failure modes are handled here so the app never hangs on the globe:
 *  - no WebGL 2 → a static hairline globe figure with a plain note; globeReady is set.
 *  - a render-time error inside the scene → the same fallback (error boundary); globeReady is set.
 *  - textures fail → an ink graticule sphere (see Earth.tsx); catalog fails → the scene runs without points.
 */
import { Canvas } from '@react-three/fiber'
import { Component, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Color } from 'three'
import { useApp } from '@/state/store'
import { palette } from '@/ui/system/palette'
import { GlobeOverlay } from './GlobeOverlay'
import { detectMobile, dprLevels, prefersReducedMotion, provisionalTier } from './quality'
import { createRuntime } from './runtime'
import { GlobeScene } from './Scene'
import s from './GlobeCanvas.module.css'

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ')

/** Starting DPR: phones 1.5 (they earn 2.0 by holding 58 fps), desktops min(2, device); never above 2 (G-M2). */
function initialDpr(mobile: boolean): number {
  return dprLevels(mobile, typeof window === 'undefined' ? 1 : window.devicePixelRatio).start
}

function webgl2Available(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!c.getContext('webgl2')
  } catch {
    return false
  }
}

export function GlobeCanvas({ className }: { className?: string }) {
  const [supported] = useState(webgl2Available)
  const [failed, setFailed] = useState(false)
  const unavailable = !supported || failed
  // Per-canvas runtime, shared by the scene (inside the R3F tree) and the DOM overlay (outside it). The tier is
  // refined from the GL context's capabilities when the scene mounts.
  const [runtime] = useState(() => createRuntime(provisionalTier(detectMobile()), prefersReducedMotion(), Date.now()))

  useEffect(() => {
    if (unavailable) useApp.getState().setGlobeReady(true)
  }, [unavailable])

  // Follow the OS setting live: camera cuts, frozen cloud drift and instant reveals switch with it.
  useEffect(() => {
    const mql = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mql) return
    const sync = () => {
      runtime.reducedMotion = mql.matches
    }
    sync()
    mql.addEventListener('change', sync)
    return () => mql.removeEventListener('change', sync)
  }, [runtime])

  return (
    <div className={cx(s.root, className)}>
      {unavailable ? (
        <GlobeFallback />
      ) : (
        <SceneBoundary onError={() => setFailed(true)}>
          <Canvas
            // DPR is managed by the scene (Scene.tsx AdaptiveDpr): phones start at 1.5, desktops at min(2, device).
            dpr={initialDpr(runtime.tier.mobile)}
            gl={{
              antialias: false, // MSAA happens in the post-processing target
              alpha: false,
              stencil: false,
              depth: false, // everything renders through the composer, which owns its depth buffer
              powerPreference: 'high-performance',
            }}
            camera={{ fov: 30, near: 0.01, far: 400, position: [0, 0, 6] }}
            // Tone mapping happens in the post chain (Post.tsx); the renderer itself stays linear.
            flat
            onCreated={({ gl, camera }) => {
              // The CameraDirector owns the projection (aspect + an off-axis lens shift) and rewrites it every frame.
              // Without `manual`, R3F recomputes the projection synchronously whenever size or DPR changes, and an
              // adaptive-DPR step taken mid-frame then renders ONE frame without the lens shift: the globe flashes
              // to the centre of the screen and back. Manual cameras are never touched by R3F.
              ;(camera as typeof camera & { manual?: boolean }).manual = true
              gl.setClearColor(new Color(palette.ink0), 1)
              // Program info-log round trips on every link are a development aid, not a production cost.
              gl.debug.checkShaderErrors = import.meta.env.DEV
            }}
            aria-hidden
          >
            <GlobeScene runtime={runtime} />
          </Canvas>
          <GlobeOverlay runtime={runtime} />
        </SceneBoundary>
      )}
    </div>
  )
}

class SceneBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error('[globe] scene failed, showing the static fallback', error)
    this.props.onError()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** Static hairline globe for browsers without WebGL 2. Honest and quiet: the rest of the app still works. */
/** The fallback note: centred lines that never run past a phone's edges (GL-1). */
const NOTE: CSSProperties = { whiteSpace: 'normal', textAlign: 'center', lineHeight: 1.7, maxWidth: 'calc(100% - 32px)' }
const NOTE_LINE: CSSProperties = { display: 'block', whiteSpace: 'nowrap' }

function GlobeFallback() {
  // Meridians at 0°, ±30°, ±60° from the central one project to a line and two ellipses.
  const meridians = [30, 60]
  const parallels = [-60, -30, 0, 30, 60]
  return (
    <div className={s.fallback}>
      <svg className={s.fallbackFigure} viewBox="-101 -101 202 202" aria-hidden>
        <g fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke">
          <circle r="100" />
          <line x1="0" x2="0" y1="-100" y2="100" />
          {meridians.map((m) => (
            <ellipse key={`m${m}`} rx={Math.abs(Math.sin((m * Math.PI) / 180)) * 100} ry="100" />
          ))}
          {parallels.map((p) => {
            const y = -Math.sin((p * Math.PI) / 180) * 100
            const w = Math.cos((p * Math.PI) / 180) * 100
            return <line key={`p${p}`} x1={-w} x2={w} y1={y} y2={y} />
          })}
        </g>
      </svg>
      {/* GL-1: two centred lines, each short enough for a 375 px phone (one line ran off both edges at 390 px). */}
      <p className={cx('t-label', s.fallbackNote)} style={NOTE}>
        <span style={NOTE_LINE}>3D view unavailable</span>
        <span style={NOTE_LINE}>WebGL 2 is off in this browser</span>
      </p>
    </div>
  )
}
