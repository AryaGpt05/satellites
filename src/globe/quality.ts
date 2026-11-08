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
  /** MSAA samples for the post-processing render target */
  msaa: number
  maxAnisotropy: number
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
    msaa: isWebGL2 && !mobile ? 4 : 0,
    maxAnisotropy: Math.min(mobile ? 4 : 8, gl.capabilities.getMaxAnisotropy()),
  }
}
