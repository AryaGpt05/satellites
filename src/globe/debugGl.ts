/**
 * `?debug=gl`: a hidden diagnostic mode for the globe on real devices (the owner's iPhone), where no devtools are at
 * hand. It shows what the GPU and the render pipeline are actually doing (DebugGl.tsx) and lets each suspect of a
 * rendering bug be switched off, one reload at a time, to bisect it on the device itself.
 *
 * Switches live in the URL (`?debug=gl&glx=nobloom,dpr1`), so a state can be shared as a link and survives the
 * reload. They are read ONCE at module load and only ever apply together with `debug=gl`: the production path never
 * sees them.
 */
import type { EffectComposer } from 'postprocessing'
import type { Camera, WebGLRenderer } from 'three'
import type { GlobeRuntime } from './runtime'

export interface GlSwitch {
  id: string
  label: string
  /** Mutually exclusive group (picking one clears the others) */
  group?: string
}

/** Every switch the panel offers, in display order. */
export const GL_SWITCHES: GlSwitch[] = [
  { id: 'nopost', label: 'no post (render straight to screen)' },
  { id: 'nobloom', label: 'no bloom' },
  { id: 'nosanitize', label: 'no NaN sanitize pass' },
  { id: 'u8', label: '8-bit composer buffers (not half-float)' },
  { id: 'msaa', label: 'MSAA ×4 in the composer' },
  { id: 'noclouds', label: 'no cloud shell' },
  { id: 'noatmo', label: 'no atmosphere shell' },
  { id: 'nostars', label: 'no stars' },
  { id: 'nosats', label: 'no satellite field' },
  { id: 'noimagery', label: 'no painted imagery' },
  { id: 'nolite', label: 'desktop shaders (no LITE)' },
  { id: 'noupgrade', label: 'no texture upgrades (stay 1k)' },
  { id: 'whole', label: 'upload upgrades whole (no strips)' },
  { id: 'nohalf', label: 'no half-rate idle frames' },
  { id: 'dpr1', label: 'DPR fixed 1', group: 'dpr' },
  { id: 'dpr15', label: 'DPR fixed 1.5', group: 'dpr' },
  { id: 'dpr2', label: 'DPR fixed 2', group: 'dpr' },
  { id: 'dpr3', label: 'DPR fixed 3', group: 'dpr' },
]

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search)

/** True when the page was opened with `?debug=gl`. */
export const GL_DEBUG = params.get('debug') === 'gl'

const flags = new Set(
  GL_DEBUG
    ? (params.get('glx') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [],
)

/** Is a debug switch on? (Always false outside `?debug=gl`.) */
export const glx = (id: string): boolean => flags.has(id)

export const activeGlSwitches = (): string[] => [...flags]

/** A fixed DPR requested by the panel, or undefined (adaptive, the normal policy). */
export function glFixedDpr(): number | undefined {
  if (glx('dpr1')) return 1
  if (glx('dpr15')) return 1.5
  if (glx('dpr2')) return 2
  if (glx('dpr3')) return 3
  return undefined
}

/** The URL with a different set of switches (the panel reloads to it). */
export function urlWithSwitches(next: Iterable<string>): string {
  const p = new URLSearchParams(location.search)
  p.set('debug', 'gl')
  const list = [...next]
  if (list.length) p.set('glx', list.join(','))
  else p.delete('glx')
  return `${location.pathname}?${p.toString()}${location.hash}`
}

/**
 * Live handles and counters for the panel, written by the scene (Scene.tsx, Post.tsx) only in debug mode.
 * Plain mutable object: the panel polls it.
 */
export const glProbe = {
  gl: null as WebGLRenderer | null,
  composer: null as EffectComposer | null,
  camera: null as Camera | null,
  rt: null as GlobeRuntime | null,
  /** Frames rendered through the composer (or straight, with nopost) */
  frames: 0,
  /** Non-finite scan of the raw scene colour (before the sanitize pass) */
  nan: { scans: 0, lastBad: 0, maxBad: 0, framesWithBad: 0, lastHuge: 0, error: '' },
  contextLost: 0,
  contextRestored: 0,
}
