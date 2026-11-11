/**
 * Per-canvas mutable runtime shared by every scene component.
 *
 * React state is the wrong tool for anything that changes every frame, so the clock, the sun, the camera's
 * flight status and a few cross-component signals live here, written in useFrame and read in useFrame.
 * Ordering is fixed by useFrame priorities (see FRAME below).
 */
import { createContext, useContext } from 'react'
import { Vector2, Vector3, Vector4, type Texture } from 'three'
import type { CameraIntent, Phase } from '@/state/store'
import { createAcqState, type AcqState } from './acquisition'
import type { TextureLevel } from './framing'
import type { QualityTier } from './quality'

/** useFrame priorities. Negative = before R3F's default (0); the post-processing composer renders at 1. */
export const FRAME = {
  /** Adaptive DPR: a resize lands before the clock reads the pixel ratio and the camera applies pose + lens shift */
  dpr: -40,
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
  /** Altitude readout, km (satellites) */
  altKm: number | null
}

export function createAnchor(): Anchor {
  return { x: 0, y: 0, visible: false, altKm: null }
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
    /** The cloud map currently bound to the cloud shell (overlays read cloud cover from it); null before load */
    uCloudMap: { value: Texture | null }
  }
  /**
   * Regional imagery painted onto the planet (shaders/chunks.ts PAINT), shared by reference by the Earth and the cloud
   * shell; written by <Imagery/> every frame.
   */
  paint: PaintUniforms
  tier: QualityTier
  reducedMotion: boolean
  camera: {
    /** True while a cinematic flight is running */
    flying: boolean
    /** performance.now() when the current intent's flight finished (or the cut happened); -Infinity before */
    arrivedAt: number
    /** The intent kind the camera last arrived at (null while none): lets the texture plan wait for a place view */
    arrivedKind: CameraIntent['kind'] | null
    /** Monotonic counter, bumped for every new camera intent */
    flightId: number
    /** Eased progress (0..1) of the running flight; 1 when settled */
    progress: number
    /** Camera height above the surface, km (for readouts) */
    altitudeKm: number
    /** Ground km per CSS px at the look-at point (drives phones' cloud-map step) */
    kmPerPx: number
  }
  /** performance.now() of the last user input on the canvas (written by CameraDirector) */
  inputAt: number
  /** True while the phone idle policy renders every 2nd frame (the DPR monitor ignores those frames) */
  throttled: boolean
  /** performance.now() when the frame loop last resumed from a pause (an overlay, About, a hidden tab) */
  resumedAt: number
  /**
   * Frames the composer skips (holding the last image on screen): AdaptiveDpr lets the GPU drain its queue before a
   * drawing-buffer resize, which otherwise blocks the main thread until every queued frame has been drawn.
   */
  skipRender: number
  /**
   * The Canvas' `dpr` prop, one stable [d, d] tuple mutated in place. R3F's Canvas re-runs configure() on every
   * render (each toolbar / visualViewport resize) and snaps the DPR back to the prop unless the prop resolves to the
   * DPR in effect: AdaptiveDpr writes its level here before setDpr, so configure() is a no-op.
   */
  dprProp: [number, number]
  /** Resolution of the day map on the GPU right now (drives the zoom floor, decision 6) */
  textureLevel: TextureLevel
  /** Resolution of the night map (the floor on the night side follows the coarser of the two) */
  nightLevel: TextureLevel
  /** store.phase as of the last frame, and performance.now() when it was entered */
  phase: Phase
  phaseEnteredAt: number
  /**
   * store.motionBusyUntil as it stood when the current phase began: a hold left by the previous phase's UI (the
   * landing's entrance, when a search is submitted early). The computing upload windows ignore it; that UI is gone.
   */
  phaseBusyFloor: number
  /**
   * performance.now() when the replay sweep last started: timeMode entering 'replay', or the clock's hold
   * releasing as the camera arrives. Texture uploads wait out the first 10 s of a sweep (the signature moment).
   */
  replayStartedAt: number
  /**
   * Sim-time jumps (|Δ| > 5 min in one frame: a pass selected or deselected, a seek): a counter bumped by
   * <Clock/>, and the sim time just before the jump. The sun glides across the jump; the point cloud dims.
   */
  timeJump: { id: number; at: number; fromSimTime: number }
  /** performance.now() of the last "swath crossed the place" event, for the reticle flash */
  flashAt: number
  /** The acquisition sequence of the selected pass (written by <Clock/>; see acquisition.ts) */
  acq: AcqState
  /** performance.now() of the last reduced-motion camera cut, for the 300 ms fade */
  cutAt: number
  /** NORAD the pass overlay draws itself; the ambient field hides its own point for it (-1 = none) */
  overlayNorad: number
  /** Screen anchors by id ('place:<lat,lon>', 'hover', 'sel:<passId>') and the DOM listeners flushed after the scene */
  anchors: Map<string, Anchor>
  anchorListeners: Set<() => void>
  /** The selected satellite's callout box as last placed (CSS px), so the coordinate label can avoid it */
  calloutBox: { x0: number; y0: number; x1: number; y1: number; visible: boolean }
  /** Bottom edge (CSS px) of the acquisition countdown while it shows (0 = hidden): callouts keep below it */
  readoutBottom: number
  /**
   * A finger pressing toward a dropped pin (PinMarker, touch / pen): where (CSS px in the canvas) and since when, for the
   * press ring the overlay draws; `at` is -1 when no press is running. `dropped` is set the moment the pin drops.
   */
  pinPress: { x: number; y: number; at: number; dropped: boolean }
  /** A satellite picked by a tap (touch) is showing its callout: the overview drift holds still under it (SatelliteField). */
  tapPicked: boolean
}

export interface PaintUniforms {
  uCtxMap: { value: Texture | null }
  uCtxUv: { value: Vector4 }
  uCtxOn: { value: number }
  uCtxLod: { value: number }
  uDayLod: { value: number }
  uDecalMap: { value: Texture | null }
  uDecalUv: { value: Vector4 }
  uDecalOn: { value: number }
  uDecal2Map: { value: Texture | null }
  uDecal2Uv: { value: Vector4 }
  uDecal2On: { value: number }
  /** 1 for an image that needs no sunlight (a radar image): it shows on the night side too. Per slot. */
  uDecalLit: { value: number }
  uDecal2Lit: { value: number }
  uScanT0: { value: Vector3 }
  uScanS: { value: number }
  uFull: { value: number }
  uFreshRad: { value: number }
  uPanelHalf: { value: number }
  /** (cos, sin) of the panel photo's turn on the map (counter-clockwise from north up): the meridian convergence */
  uPanelTurn: { value: Vector2 }
  uCloudFade: { value: number }
}

export function createPaintUniforms(): PaintUniforms {
  return {
    uCtxMap: { value: null },
    uCtxUv: { value: new Vector4(0.5, 0.5, 0.01, 0.01) },
    uCtxOn: { value: 0 },
    uCtxLod: { value: 6 },
    uDayLod: { value: 3 },
    uDecalMap: { value: null },
    uDecalUv: { value: new Vector4(0.5, 0.5, 0.01, 0.01) },
    uDecalOn: { value: 0 },
    uDecal2Map: { value: null },
    uDecal2Uv: { value: new Vector4(0.5, 0.5, 0.01, 0.01) },
    uDecal2On: { value: 0 },
    uDecalLit: { value: 0 },
    uDecal2Lit: { value: 0 },
    uScanT0: { value: new Vector3(0, 1, 0) },
    uScanS: { value: 0 },
    uFull: { value: 1 },
    uFreshRad: { value: 0.001 },
    uPanelHalf: { value: 0 },
    uPanelTurn: { value: new Vector2(1, 0) },
    uCloudFade: { value: 1 },
  }
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
      uCloudMap: { value: null },
    },
    paint: createPaintUniforms(),
    tier,
    reducedMotion,
    camera: { flying: false, arrivedAt: -Infinity, arrivedKind: null, flightId: 0, progress: 1, altitudeKm: 0, kmPerPx: Infinity },
    inputAt: -Infinity,
    throttled: false,
    resumedAt: -Infinity,
    skipRender: 0,
    dprProp: [1, 1],
    textureLevel: '1k',
    nightLevel: '1k',
    phase: 'boot',
    phaseEnteredAt: 0,
    phaseBusyFloor: 0,
    replayStartedAt: -Infinity,
    timeJump: { id: 0, at: -Infinity, fromSimTime: now },
    flashAt: -Infinity,
    acq: createAcqState(),
    cutAt: -Infinity,
    overlayNorad: -1,
    anchors: new Map(),
    anchorListeners: new Set(),
    calloutBox: { x0: 0, y0: 0, x1: 0, y1: 0, visible: false },
    readoutBottom: 0,
    pinPress: { x: 0, y: 0, at: -1, dropped: false },
    tapPicked: false,
  }
}

export const RuntimeContext = createContext<GlobeRuntime | null>(null)

export function useRuntime(): GlobeRuntime {
  const rt = useContext(RuntimeContext)
  if (!rt) throw new Error('useRuntime must be used inside <GlobeCanvas/>')
  return rt
}
