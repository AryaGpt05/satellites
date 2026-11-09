/**
 * Device capability tiers for the globe. Decided once per canvas from the WebGL context and the viewport.
 */
import type { WebGLRenderer } from 'three'

export interface QualityTier {
  /** Phone-class device: coarse pointer or small screen */
  mobile: boolean
  /** Upgrade the 1k textures to 4k once the first frame is up */
  allow4k: boolean
  /** Also upgrade the day map to 8k (capable desktops only) */
  allow8k: boolean
  /** Earth sphere tessellation (width segments; height = half) */
  sphereSegments: number
  /** WebGL 2 context (multisampled render targets available) */
  webgl2: boolean
  maxAnisotropy: number
}

/**
 * MSAA samples for the post-processing target at the pixel ratio actually in effect (PERF-08): none at
 * DPR ≥ 1.5 (the pixels are already small, and points / hairlines anti-alias in their own shaders) and none on
 * phones; 4 on desktop at DPR < 1.5.
 */
export function msaaFor(tier: QualityTier, pixelRatio: number): number {
  return tier.webgl2 && !tier.mobile && pixelRatio < 1.5 ? 4 : 0
}

export function detectMobile(): boolean {
  if (typeof window === 'undefined') return false
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const small = Math.min(window.screen?.width ?? 1024, window.screen?.height ?? 1024) < 600
  return coarse || small
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
}

/** Best guess before a GL context exists (replaced by detectTier once the canvas is up). */
export function provisionalTier(mobile: boolean): QualityTier {
  return { mobile, allow4k: true, allow8k: false, sphereSegments: mobile ? 160 : 288, webgl2: true, maxAnisotropy: 4 }
}

export function detectTier(gl: WebGLRenderer): QualityTier {
  const mobile = detectMobile()
  const maxTex = gl.capabilities.maxTextureSize
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const isWebGL2 = gl.capabilities.isWebGL2
  return {
    mobile,
    allow4k: maxTex >= 4096,
    allow8k: !mobile && maxTex >= 8192 && (memory === undefined || memory >= 8),
    sphereSegments: mobile ? 160 : 288,
    webgl2: isWebGL2,
    maxAnisotropy: Math.min(mobile ? 4 : 8, gl.capabilities.getMaxAnisotropy()),
  }
}

/**
 * Where a DPR decline lands: one step for a device that is just short of the target, more for one that is far
 * from it, so a slow device pays for ONE drawing-buffer reallocation instead of a staircase of them (each one is a
 * GPU sync; G-M1). Fill cost goes with dpr², so the level that would bring `fps` up to `targetFps` is
 * dpr × √(fps / target), floored to a level, and always at least one step below `index`.
 */
export function declineLevel(levels: number[], index: number, fps: number, targetFps: number): number {
  if (index <= 0) return 0
  const want = levels[index] * Math.sqrt(Math.max(0, fps) / Math.max(1, targetFps))
  let i = index - 1
  while (i > 0 && levels[i] > want + 1e-6) i--
  return i
}

/** The pixel ratio the canvas may ever use: the device's, never above 2 (DESIGN §9, G-M2) nor below 1. */
export const maxDpr = (ratio: number) => Math.min(2, Math.max(1, ratio || 1))

/**
 * Adaptive-DPR levels and the starting level (PERF-08): phones start at 1.5 (floor 1.0) and earn 2.0 only by holding
 * 58 fps; desktops start at their (capped) device ratio.
 */
export function dprLevels(mobile: boolean, ratio: number): { levels: number[]; start: number } {
  const device = maxDpr(ratio)
  const steps = mobile ? [1, 1.25, Math.min(1.5, device), device] : [1, 1.25, 1.5, 1.75, device].filter((v) => v <= device)
  return { levels: [...new Set(steps)].sort((a, b) => a - b), start: mobile ? Math.min(1.5, device) : device }
}
