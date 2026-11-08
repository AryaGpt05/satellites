/**
 * Scene composition. Order of work each frame is fixed by useFrame priorities (runtime.ts FRAME):
 *   AdaptiveDpr → Clock (sim time, sun, GMST, texture-upload slices) → CameraDirector → scene components → post
 *   composer.
 *
 * Also owns the frame-rate policy: adaptive DPR that only changes while nothing choreographed is moving
 * (PERF-08), no rendering at all behind the About page or in a hidden tab (PERF-10), and the boot-time shader
 * warm-up so no overlay program links on frame 1 of a flight (PERF-02).
 */
import { useFrame, useThree } from '@react-three/fiber'
import type { EffectComposer } from 'postprocessing'
import { useEffect, useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Group, Mesh, PlaneGeometry, Points, type Material } from 'three'
import { useApp } from '@/state/store'
import { CameraDirector } from './CameraDirector'
import { Clock } from './Clock'
import { useCatalogBuffers } from './data'
import { Atmosphere, Clouds, Earth, EarthFallback, useSphere } from './Earth'
import { Hairline } from './hairline'
import {
  createFadeMaterial,
  createGlyphMaterial,
  createReticleMaterial,
  createRibbonMaterial,
  createSatellitesMaterial,
  lin,
} from './materials'
import { PassOverlay } from './PassOverlay'
import { PlaceMarker } from './PlaceMarker'
import { usePost } from './Post'
import { detectTier } from './quality'
import { FRAME, RuntimeContext, useRuntime, type GlobeRuntime } from './runtime'
import { SatelliteField } from './SatelliteField'
import { Stars } from './Stars'
import { useEarthTextures } from './textures'

export function GlobeScene({ runtime }: { runtime: GlobeRuntime }) {
  const gl = useThree((s) => s.gl)
  // Refine the device tier from the real context before any child reads it.
  useMemo(() => {
    runtime.tier = detectTier(gl)
  }, [gl, runtime])
  const textures = useEarthTextures(gl, runtime)
  const catalog = useCatalogBuffers()
  // One sphere for the planet and its cloud shell (scaled).
  const sphere = useSphere(runtime.tier.sphereSegments)

  // Hook for screenshot scripts and perf probes: dev and `vite build --mode inspect` only, never in production.
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    if (!import.meta.env.DEV && import.meta.env.MODE !== 'inspect') return
    ;(window as unknown as { __globe?: unknown }).__globe = { rt: runtime, gl, scene, camera, useApp }
  }, [gl, runtime, scene, camera])

  return (
    <RuntimeContext.Provider value={runtime}>
      <Clock />
      <CameraDirector />
      <AdaptiveDpr />
      <FrameloopControl />
      <Stars />
      {textures.state === 'ready' && (
        <>
          <Earth textures={textures.textures} geometry={sphere} />
          <Clouds textures={textures.textures} geometry={sphere} />
        </>
      )}
      {textures.state === 'error' && <EarthFallback />}
      {textures.state !== 'loading' && <Atmosphere />}
      {catalog.state === 'ready' && <SatelliteField data={catalog.data} />}
      <PlaceMarker />
      {catalog.state === 'ready' && <PassOverlay />}
      <ReadySignal ready={textures.state !== 'loading'} />
      <AnchorFlush />
      <PostAndWarmup />
    </RuntimeContext.Provider>
  )
}

/** Hands this frame's screen anchors to the DOM overlay, after every scene component has written them. */
function AnchorFlush() {
  const rt = useRuntime()
  useFrame(() => {
    for (const l of rt.anchorListeners) l()
  }, FRAME.anchors)
  return null
}

/** Sets store.globeReady once the first textures have actually been on screen for a couple of frames. */
function ReadySignal({ ready }: { ready: boolean }) {
  const frames = useRef(0)
  const done = useRef(false)
  useFrame(() => {
    if (!ready || done.current) return
    if (++frames.current >= 3) {
      done.current = true
      useApp.getState().setGlobeReady(true)
    }
  }, FRAME.scene)
  return null
}

function PostAndWarmup() {
  const composer = usePost()
  return <ShaderWarmup composer={composer} />
}

// ───────────────────────────── shader warm-up (PERF-02) ─────────────────────────────

/**
 * One instance of every overlay material (from the same factories the real components use), each on a
 * single-vertex geometry so nothing rasterises, rendered through the composer for two real frames under the boot
 * curtain. three caches programs by source + parameters (including the composer target's colour space, which is
 * why this goes through the composer and not a bare gl.compile against the canvas). Where the browser can
 * compile in parallel (KHR_parallel_shader_compile), compileAsync starts the work against the composer's input
 * buffer first. Afterwards the objects are hidden but the materials stay alive, so the programs stay cached.
 */
function ShaderWarmup({ composer }: { composer: EffectComposer }) {
  const rt = useRuntime()
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const group = useRef<Group>(null)

  const kit = useMemo(() => {
    const one = () => {
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(new Float32Array(3), 3))
      return g
    }
    const ribbonGeo = one()
    for (const a of ['aAlong', 'aSide', 'aU']) ribbonGeo.setAttribute(a, new BufferAttribute(new Float32Array(1), 1))
    const satGeo = one()
    for (const a of ['aEl0', 'aEl1', 'aEl2']) satGeo.setAttribute(a, new BufferAttribute(new Float32Array(4), 4))
    satGeo.setAttribute('aMark', new BufferAttribute(new Float32Array(1), 1))
    const hairline = new Hairline({ capacity: 1, color: lin('#ffffff'), opacity: 0, uPx: rt.uniforms.uPx })
    const shared = { uPx: rt.uniforms.uPx, uSunDir: rt.uniforms.uSunDir, uCloudMap: rt.uniforms.uCloudMap, uCloudOffset: rt.uniforms.uCloudOffset }
    // Geometry attribute sets matter (e.g. normals are part of the program key), so each stand-in uses the same
    // geometry type as the real object: planes for the reticle and the fade quad, bare buffers for the rest.
    const objects: (Mesh | Points)[] = [
      new Mesh(new PlaneGeometry(1, 1), createReticleMaterial(rt.uniforms.uPx, 15, 112)),
      new Mesh(ribbonGeo, createRibbonMaterial(shared, { kind: 0, color: lin('#ffffff'), fill: 0 }, { speedKmS: 7 })),
      new Mesh(hairline.geometry, hairline.material),
      new Points(one(), createGlyphMaterial(rt.uniforms.uPx, { size: 13, shape: 0, filled: true })),
      new Mesh(new PlaneGeometry(2, 2), createFadeMaterial()),
      new Points(satGeo, createSatellitesMaterial(rt.uniforms.uPx)),
    ]
    for (const o of objects) {
      o.frustumCulled = false
      const m = o.material as Material & { uniforms?: Record<string, { value: unknown }> }
      if (m.uniforms?.uOpacity) m.uniforms.uOpacity.value = 0
      if (m.uniforms?.uReveal) m.uniforms.uReveal.value = 0
    }
    return { objects }
  }, [rt])
  useEffect(
    () => () => {
      for (const o of kit.objects) {
        o.geometry.dispose()
        ;(o.material as Material).dispose()
      }
    },
    [kit],
  )

  const st = useRef({ frames: 0, compiled: false, started: false })
  useEffect(() => {
    const g = group.current
    if (!g || st.current.started) return
    st.current.started = true
    const parallel = gl.extensions.get('KHR_parallel_shader_compile') !== null
    if (!parallel) {
      st.current.compiled = true
      return
    }
    const prev = gl.getRenderTarget()
    gl.setRenderTarget(composer.inputBuffer)
    const done = gl.compileAsync(g, camera, scene)
    gl.setRenderTarget(prev)
    done.then(
      () => (st.current.compiled = true),
      () => (st.current.compiled = true),
    )
  }, [gl, camera, scene, composer])

  useFrame(() => {
    const g = group.current
    if (!g || !g.visible) return
    // Two real frames through the composer once compiled, then hide (materials stay alive).
    if (st.current.compiled && ++st.current.frames > 2) g.visible = false
  }, FRAME.scene)

  return (
    <group ref={group}>
      {kit.objects.map((o, i) => (
        <primitive key={i} object={o} />
      ))}
    </group>
  )
}

// ───────────────────────────── frame-rate policy ─────────────────────────────

/**
 * Frame-loop policy (PERF-10):
 *  - behind the opaque About page or in a hidden tab: no rendering at all ('never'); resume with a fresh frame
 *    (Clock and CameraDirector clamp the gap, so nothing jumps);
 *  - phones idling on the landing (no flight, no touch for 1.5 s, no replay): every 2nd animation frame, since
 *    the only motion is the 0.6°/s drift. A touch on the canvas restores full rate at once.
 */
function FrameloopControl() {
  const rt = useRuntime()
  const gl = useThree((s) => s.gl)
  const setFrameloop = useThree((s) => s.setFrameloop)
  const invalidate = useThree((s) => s.invalidate)
  const mode = useRef<'always' | 'never' | 'half'>('always')
  const applyRef = useRef<((m: 'always' | 'never' | 'half') => void) | null>(null)

  useEffect(() => {
    let raf = 0
    let odd = false
    const tick = () => {
      odd = !odd
      if (odd) invalidate()
      raf = requestAnimationFrame(tick)
    }
    const apply = (next: 'always' | 'never' | 'half') => {
      if (next === mode.current) return
      mode.current = next
      cancelAnimationFrame(raf)
      raf = 0
      rt.throttled = next === 'half'
      if (next === 'never') setFrameloop('never')
      else if (next === 'always') {
        setFrameloop('always')
        invalidate()
      } else {
        setFrameloop('demand')
        raf = requestAnimationFrame(tick)
      }
    }
    const paused = () => useApp.getState().aboutOpen || (typeof document !== 'undefined' && document.hidden)
    const sync = () => apply(paused() ? 'never' : mode.current === 'never' ? 'always' : mode.current)
    sync()
    const unsub = useApp.subscribe((s, prev) => {
      if (s.aboutOpen !== prev.aboutOpen) sync()
      // Anything that starts motion wakes the loop before the next frame.
      if (mode.current === 'half' && (s.phase !== prev.phase || s.camera !== prev.camera || s.timeMode !== prev.timeMode)) apply('always')
    })
    const wake = () => {
      if (mode.current === 'half') apply('always')
    }
    document.addEventListener('visibilitychange', sync)
    gl.domElement.addEventListener('pointerdown', wake)
    gl.domElement.addEventListener('wheel', wake, { passive: true })
    applyRef.current = apply
    return () => {
      unsub()
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', sync)
      gl.domElement.removeEventListener('pointerdown', wake)
      gl.domElement.removeEventListener('wheel', wake)
      rt.throttled = false
    }
  }, [gl, rt, setFrameloop, invalidate])

  // Decide the phone idle policy on rendered frames (cheap checks only).
  useFrame(() => {
    if (!rt.tier.mobile || mode.current === 'never') return
    const st = useApp.getState()
    const now = performance.now()
    const idle =
      st.phase === 'idle' &&
      !rt.camera.flying &&
      st.timeMode !== 'replay' &&
      st.hoveredNorad === undefined &&
      now - rt.inputAt > 1500 &&
      now - rt.phaseEnteredAt > 3000 &&
      now > st.motionBusyUntil
    const want = idle ? 'half' : 'always'
    if (want !== mode.current) applyRef.current?.(want)
  })
  return null
}

/** Frame-time sampling window (ms) and how many windows a decision needs. */
const FPS_WINDOW_MS = 500
const DECLINE_WINDOWS = 4 // 2 s of bad frames
const INCLINE_MS = 3000 // ≥ 58 fps for 3 s before going up
const INCLINE_FPS = 58
/** Direction reversals allowed before the DPR freezes (settles instead of oscillating). */
const FLIPFLOPS = 2

/**
 * DPR policy (PERF-08). Phones start at 1.5 (floor 1.0) and only reach 2.0 after ≥ 58 fps for 3 s; desktops
 * start at min(2, device). A change reallocates the composer's targets, so changes are QUEUED and applied only
 * when no camera flight is running (and ≥ 1 s after one lands, past the reticle lock-in), more than 2 s after a
 * phase change and after store.motionBusyUntil.
 */
function AdaptiveDpr() {
  const rt = useRuntime()
  const setDpr = useThree((s) => s.setDpr)
  const ctl = useMemo(() => {
    const device = Math.min(2, Math.max(1, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))
    const steps = rt.tier.mobile
      ? [1, 1.25, Math.min(1.5, device), device]
      : [1, 1.25, 1.5, 1.75, device].filter((v) => v <= device)
    const levels = [...new Set(steps)].sort((a, b) => a - b)
    const start = rt.tier.mobile ? Math.min(1.5, device) : device
    return {
      levels,
      index: Math.max(0, levels.indexOf(start)),
      want: -1,
      frames: 0,
      windowStart: -1,
      low: 0, // consecutive low windows
      highSince: -1,
      refresh: 0,
      flips: 0,
      lastDir: 0,
    }
  }, [rt])

  useEffect(() => {
    setDpr(ctl.levels[ctl.index])
    // Probe hook (dev / inspect builds only): queue a DPR step through the real policy, as a frame-rate change would.
    if (!import.meta.env.DEV && import.meta.env.MODE !== 'inspect') return
    ;(window as unknown as { __forceDpr?: (dpr: number) => void }).__forceDpr = (dpr: number) => {
      let best = 0
      ctl.levels.forEach((v, i) => {
        if (Math.abs(v - dpr) < Math.abs(ctl.levels[best] - dpr)) best = i
      })
      ctl.want = best
      ctl.flips = 0
    }
  }, [ctl, setDpr])

  useFrame(() => {
    const now = performance.now()
    const c = ctl
    // Half-rate idle frames say nothing about the device: restart the window.
    if (rt.throttled) {
      c.windowStart = -1
      c.frames = 0
      c.highSince = -1
      return
    }
    if (c.windowStart < 0) c.windowStart = now
    c.frames++
    const span = now - c.windowStart
    if (span >= FPS_WINDOW_MS) {
      const fps = (c.frames * 1000) / span
      c.frames = 0
      c.windowStart = now
      c.refresh = Math.max(c.refresh, fps)
      const lower = c.refresh > 90 ? 50 : 40
      c.low = fps < lower ? c.low + 1 : 0
      if (fps >= INCLINE_FPS) {
        if (c.highSince < 0) c.highSince = now
      } else c.highSince = -1
      if (c.flips <= FLIPFLOPS) {
        if (c.low >= DECLINE_WINDOWS && c.index > 0) {
          c.want = c.index - 1
          c.low = 0
        } else if (c.highSince >= 0 && now - c.highSince >= INCLINE_MS && c.index < c.levels.length - 1) {
          c.want = c.index + 1
          c.highSince = -1
        }
      }
    }
    // Apply a queued change only while nothing choreographed is moving.
    if (c.want >= 0 && c.want !== c.index) {
      const st = useApp.getState()
      const quiet =
        !rt.camera.flying && now - rt.camera.arrivedAt > 1000 && now - rt.phaseEnteredAt > 2000 && now > st.motionBusyUntil
      if (quiet) {
        const dir = Math.sign(c.want - c.index)
        if (c.lastDir !== 0 && dir !== c.lastDir) c.flips++
        c.lastDir = dir
        c.index = c.want
        c.want = -1
        setDpr(c.levels[c.index])
        if (import.meta.env.DEV) {
          const w = window as unknown as { __dprLog?: unknown[] }
          ;(w.__dprLog ??= []).push({ t: Math.round(now), dpr: c.levels[c.index], flying: rt.camera.flying, sincePhase: Math.round(now - rt.phaseEnteredAt), phase: rt.phase })
        }
      }
    }
    // Before the clock and the camera: the drawing buffer resizes first, then this frame's pose and lens shift are
    // applied to it (the camera is manual, so R3F's resize never resets the projection).
  }, FRAME.dpr)
  return null
}
