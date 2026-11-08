/**
 * Scene composition. Order of work each frame is fixed by useFrame priorities (runtime.ts FRAME):
 *   Clock (sim time, sun, GMST) → CameraDirector → scene components → render (post-processing composer).
 */
import { PerformanceMonitor } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '@/state/store'
import { CameraDirector } from './CameraDirector'
import { Clock } from './Clock'
import { useCatalogBuffers } from './data'
import { Atmosphere, Clouds, Earth, EarthFallback } from './Earth'
import { PassOverlay } from './PassOverlay'
import { PlaceMarker } from './PlaceMarker'
import { Post } from './Post'
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
  const textures = useEarthTextures(gl, runtime.tier)
  const catalog = useCatalogBuffers()

  return (
    <RuntimeContext.Provider value={runtime}>
      <Clock />
      <CameraDirector />
      <AdaptiveDpr />
      <Stars />
      {textures.state === 'ready' && (
        <>
          <Earth textures={textures.textures} />
          <Clouds textures={textures.textures} />
        </>
      )}
      {textures.state === 'error' && <EarthFallback />}
      {textures.state !== 'loading' && <Atmosphere />}
      {catalog.state === 'ready' && <SatelliteField data={catalog.data} />}
      <PlaceMarker />
      {catalog.state === 'ready' && <PassOverlay />}
      <ReadySignal ready={textures.state !== 'loading'} />
      <AnchorFlush />
      <Post />
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

/**
 * DPR in [1, 2] (and never above the device's), stepped down when frame time is bad and back up when it
 * recovers. Bounded flip-flops so it settles instead of oscillating.
 */
function AdaptiveDpr() {
  const setDpr = useThree((s) => s.setDpr)
  const max = Math.min(2, Math.max(1, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))
  const [factor, setFactor] = useState(1)
  useEffect(() => {
    setDpr(1 + (max - 1) * factor)
  }, [factor, max, setDpr])
  return (
    <PerformanceMonitor
      bounds={(refresh) => (refresh > 90 ? [50, 80] : [40, 56])}
      flipflops={4}
      onDecline={() => setFactor((f) => Math.max(0, f - 0.34))}
      onIncline={() => setFactor((f) => Math.min(1, f + 0.34))}
    />
  )
}
