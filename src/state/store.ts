/**
 * Global app state (zustand). This is the integration contract between UI, engine and globe.
 * - UI writes intents (place, selection, time controls).
 * - Engine results land in `report`.
 * - Globe READS everything here and writes only `globeReady`, `hoveredNorad` (hovers it started) and
 *   `simTime` (its frame loop owns the clock: throttled ~10 Hz in live/replay).
 */
import { create } from 'zustand'
import type { Pass, Place, ProgressEvent, Report } from '@/types'

export type Phase =
  | 'boot' // loading textures + catalog
  | 'idle' // landing: globe spinning, search visible
  | 'locating' // geocoding / geolocation
  | 'computing' // engine running; progress shown
  | 'results' // report available
  | 'error'

export type CameraIntent =
  | { kind: 'overview' } // slow orbit, whole Earth, slightly offset so the HUD breathes
  | { kind: 'place'; lat: number; lon: number } // fly to place, regional altitude
  | { kind: 'pass'; passId: string } // frame the pass: ground track + place, looking along-track
  | { kind: 'satellite'; norad: number } // chase cam near a satellite

export interface AppState {
  phase: Phase
  error?: string
  place?: Place
  report?: Report
  /** The [start, end] window of the report being computed (ms). Set by the controller before computing. */
  pendingWindow?: [number, number]
  progress?: ProgressEvent
  selectedPassId?: string
  hoveredNorad?: number
  /** Simulation clock. When `live`, the globe advances simTime with wall time. */
  timeMode: 'live' | 'scrub' | 'replay'
  simTime: number
  /** Playback rate for 'replay' (sim seconds per real second) */
  replayRate: number
  camera: CameraIntent
  /** Toggles */
  showAmbient: boolean
  globeReady: boolean
  catalogReady: boolean

  // actions
  setPhase: (p: Phase, error?: string) => void
  setPlace: (p?: Place) => void
  setPendingWindow: (w?: [number, number]) => void
  setReport: (r?: Report) => void
  setProgress: (e?: ProgressEvent) => void
  selectPass: (id?: string) => void
  setHoveredNorad: (n?: number) => void
  setTimeMode: (m: AppState['timeMode']) => void
  setSimTime: (t: number) => void
  setReplayRate: (r: number) => void
  setCamera: (c: CameraIntent) => void
  setGlobeReady: (v: boolean) => void
  setCatalogReady: (v: boolean) => void
  reset: () => void
}

export const useApp = create<AppState>((set) => ({
  phase: 'boot',
  timeMode: 'live',
  simTime: Date.now(),
  replayRate: 60,
  camera: { kind: 'overview' },
  showAmbient: true,
  globeReady: false,
  catalogReady: false,

  setPhase: (phase, error) => set({ phase, error }),
  setPlace: (place) => set({ place }),
  setPendingWindow: (pendingWindow) => set({ pendingWindow }),
  setReport: (report) => set({ report }),
  setProgress: (progress) => set({ progress }),
  selectPass: (selectedPassId) => set({ selectedPassId }),
  setHoveredNorad: (hoveredNorad) => set({ hoveredNorad }),
  setTimeMode: (timeMode) => set({ timeMode }),
  setSimTime: (simTime) => set({ simTime }),
  setReplayRate: (replayRate) => set({ replayRate }),
  setCamera: (camera) => set({ camera }),
  setGlobeReady: (globeReady) => set({ globeReady }),
  setCatalogReady: (catalogReady) => set({ catalogReady }),
  reset: () =>
    set({
      phase: 'idle',
      place: undefined,
      report: undefined,
      pendingWindow: undefined,
      progress: undefined,
      selectedPassId: undefined,
      timeMode: 'live',
      simTime: Date.now(),
      camera: { kind: 'overview' },
    }),
}))

export const selectSelectedPass = (s: AppState): Pass | undefined =>
  s.report?.passes.find((p) => p.id === s.selectedPassId)
