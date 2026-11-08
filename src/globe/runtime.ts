/**
 * Per-canvas mutable runtime shared by every scene component.
 *
 * React state is the wrong tool for anything that changes every frame, so the clock, the sun, the camera's
 * flight status and a few cross-component signals live here, written in useFrame and read in useFrame.
 * Ordering is fixed by useFrame priorities (see FRAME below).
 */
import { createContext, useContext } from 'react'
import { Vector3 } from 'three'
import type { QualityTier } from './quality'

/** useFrame priorities. Negative = before R3F's default (0); the post-processing composer renders at 1. */
export const FRAME = {
  clock: -30,
  camera: -20,
  scene: -10,
  /** After every scene component has written its screen anchors */
  anchors: -5,
} as const

/**
 * A point the DOM overlay follows (callouts, the coordinate label). Written by scene components each frame
 * in CSS pixels relative to the canvas; read by GlobeOverlay in the same frame.
 */
export interface Anchor {
  x: number
  y: number
  visible: boolean
  /** Put the callout box below the point (near the top edge) */
  below: boolean
  /** Altitude readout, km (satellites) */
  altKm: number | null
}

export function createAnchor(): Anchor {
  return { x: 0, y: 0, visible: false, below: false, altKm: null }
}

export interface GlobeRuntime {
  /** Simulation time (epoch ms) for the current frame. Written by <Clock/> before anything else runs. */
  simTime: number
  /** simTime of the previous frame, to detect crossings (e.g. the swath passing over the place). */
  prevSimTime: number
  /** Unit vector to the Sun, world frame, for the current simTime. */
  sunDir: Vector3
  /** Greenwich mean sidereal time (rad) for the current simTime. */
  gmst: number
  /** Uniform objects shared by reference across materials, so one write updates every shader. */
  uniforms: {
    uSunDir: { value: Vector3 }
    /** Horizontal offset of the cloud layer in texture space (drift) */
    uCloudOffset: { value: number }
    /** Device pixel ratio in effect, for pixel-exact strokes */
    uPx: { value: number }
  }
  tier: QualityTier
  reducedMotion: boolean
  camera: {
    /** True while a cinematic flight is running */
    flying: boolean
    /** performance.now() when the current intent's flight finished (or the cut happened); -Infinity before */
    arrivedAt: number
    /** Monotonic counter, bumped for every new camera intent */
    flightId: number
    /** Camera height above the surface, km (for readouts) */
    altitudeKm: number
  }
  /** performance.now() of the last "swath crossed the place" event, for the reticle flash */
  flashAt: number
  /** performance.now() of the last reduced-motion camera cut, for the 300 ms fade */
  cutAt: number
  /** NORAD the pass overlay draws itself; the ambient field hides its own point for it (-1 = none) */
  overlayNorad: number
  /** Screen anchors by id ('place', 'hover', 'selected') and the DOM listeners flushed after the scene */
  anchors: Map<string, Anchor>
  anchorListeners: Set<() => void>
}

export function createRuntime(tier: QualityTier, reducedMotion: boolean, now: number): GlobeRuntime {
  const sunDir = new Vector3(1, 0, 0)
  return {
    simTime: now,
    prevSimTime: now,
    sunDir,
    gmst: 0,
    uniforms: {
      uSunDir: { value: sunDir },
      uCloudOffset: { value: 0 },
      uPx: { value: 1 },
    },
    tier,
    reducedMotion,
    camera: { flying: false, arrivedAt: -Infinity, flightId: 0, altitudeKm: 0 },
    flashAt: -Infinity,
    cutAt: -Infinity,
    overlayNorad: -1,
    anchors: new Map(),
    anchorListeners: new Set(),
  }
}

export const RuntimeContext = createContext<GlobeRuntime | null>(null)

export function useRuntime(): GlobeRuntime {
  const rt = useContext(RuntimeContext)
  if (!rt) throw new Error('useRuntime must be used inside <GlobeCanvas/>')
  return rt
}
