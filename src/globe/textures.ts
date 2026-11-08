/**
 * Progressive Earth textures.
 *
 *   1k set (day, night, clouds, data; ~0.5 MB) → first frame → globeReady
 *   → 4k set, one texture at a time while the browser is idle
 *   → 8k day map on capable desktops (maxTextureSize ≥ 8192, not mobile)
 *
 * Images are decoded off the main thread with createImageBitmap where that is reliable (same rule as three's
 * GLTFLoader), uploaded to the GPU before they are swapped in (so the swap never stalls a frame), and the
 * texture they replace is disposed. Colour maps are sRGB; the cloud and data maps are data (no conversion).
 */
import { useEffect, useState } from 'react'
import {
  ImageBitmapLoader,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  ClampToEdgeWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  type WebGLRenderer,
} from 'three'
import type { QualityTier } from './quality'

export type EarthMap = 'day' | 'night' | 'clouds' | 'data'
export type EarthTextures = Record<EarthMap, Texture>

export type TextureStatus =
  | { state: 'loading' }
  | { state: 'ready'; textures: EarthTextures; level: '1k' | '4k' | '8k' }
  | { state: 'error'; error: Error }

const BASE = '/textures/'
const url = (map: EarthMap, res: '1k' | '4k' | '8k') => `${BASE}earth-${map}-${res}.webp`

function useBitmaps(): boolean {
  if (typeof createImageBitmap === 'undefined' || typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const safari = /^((?!chrome|android).)*safari/i.test(ua)
  const safariVersion = safari ? Number(ua.match(/Version\/(\d+)/)?.[1] ?? 0) : -1
  const firefox = ua.includes('Firefox')
  const firefoxVersion = firefox ? Number(ua.match(/Firefox\/(\d+)/)?.[1] ?? 0) : -1
  return !((safari && safariVersion < 17) || (firefox && firefoxVersion < 98))
}

/** Load one map. Rejects on network / decode failure. */
export function loadMap(map: EarthMap, res: '1k' | '4k' | '8k', anisotropy: number, signal?: AbortSignal): Promise<Texture> {
  return new Promise<Texture>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const done = (tex: Texture) => {
      if (signal?.aborted) {
        tex.dispose()
        return reject(new DOMException('Aborted', 'AbortError'))
      }
      configure(tex, map, anisotropy)
      resolve(tex)
    }
    const fail = (e: unknown) => reject(e instanceof Error ? e : new Error(`Texture ${url(map, res)} failed to load`))
    if (res !== '1k' && useBitmaps()) {
      const loader = new ImageBitmapLoader()
      loader.setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      loader.load(
        url(map, res),
        (bitmap) => {
          const tex = new Texture(bitmap as unknown as HTMLImageElement)
          tex.flipY = false // already flipped while decoding
          tex.needsUpdate = true
          done(tex)
        },
        undefined,
        fail,
      )
    } else {
      // Image elements without a crossOrigin attribute (same-origin) reuse index.html's <link rel=preload>.
      const loader = new TextureLoader()
      loader.setCrossOrigin(undefined as unknown as string)
      loader.load(url(map, res), done, undefined, fail)
    }
  })
}

function configure(tex: Texture, map: EarthMap, anisotropy: number) {
  tex.colorSpace = map === 'day' || map === 'night' ? SRGBColorSpace : NoColorSpace
  // Clouds drift in longitude, so they wrap horizontally; the others clamp to avoid a seam bleed at the poles.
  tex.wrapS = map === 'clouds' ? RepeatWrapping : ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.minFilter = LinearMipmapLinearFilter
  tex.magFilter = LinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = map === 'data' ? 1 : anisotropy
}

/** Free GPU + decoded image memory. */
function disposeTexture(tex: Texture) {
  const img = tex.image as { close?: () => void } | undefined
  tex.dispose()
  img?.close?.()
}

const MAPS: EarthMap[] = ['day', 'night', 'clouds', 'data']

/** Which maps get upgraded, in order, for a device tier. Phones keep the 1k elevation/ocean mask (subtle at their size). */
export function upgradePlan(tier: QualityTier): { map: EarthMap; res: '4k' | '8k' }[] {
  if (!tier.allow4k) return []
  const plan: { map: EarthMap; res: '4k' | '8k' }[] = [
    { map: 'day', res: '4k' },
    { map: 'night', res: '4k' },
    { map: 'clouds', res: '4k' },
  ]
  if (!tier.mobile) plan.push({ map: 'data', res: '4k' })
  if (tier.allow8k) plan.push({ map: 'day', res: '8k' })
  return plan
}

const idle = (fn: () => void, timeout = 1500): (() => void) => {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(fn, { timeout })
    return () => w.cancelIdleCallback?.(id)
  }
  const id = window.setTimeout(fn, 200)
  return () => window.clearTimeout(id)
}

/**
 * React binding. Returns the current texture set. Upgrades mutate it in place (same object, a new Texture per
 * key); materials re-bind by identity in their frame callback, so a replaced texture is never referenced by
 * the time it is disposed (three frames later).
 */
export function useEarthTextures(gl: WebGLRenderer, tier: QualityTier, onFirstReady?: () => void): TextureStatus {
  const [status, setStatus] = useState<TextureStatus>({ state: 'loading' })

  useEffect(() => {
    const ctl = new AbortController()
    let cancelIdle: (() => void) | undefined
    let current: EarthTextures | undefined

    const loadFirst = async (attempt: number): Promise<EarthTextures> => {
      try {
        const list = await Promise.all(MAPS.map((m) => loadMap(m, '1k', tier.maxAnisotropy, ctl.signal)))
        return { day: list[0], night: list[1], clouds: list[2], data: list[3] }
      } catch (e) {
        if (ctl.signal.aborted || attempt >= 2) throw e
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)))
        return loadFirst(attempt + 1)
      }
    }

    const upgrade = async () => {
      for (const step of upgradePlan(tier)) {
        if (ctl.signal.aborted || !current) return
        // Wait for an idle slot so decoding and upload never compete with a camera flight's first frames.
        await new Promise<void>((r) => {
          cancelIdle = idle(r)
        })
        let tex: Texture
        try {
          tex = await loadMap(step.map, step.res, tier.maxAnisotropy, ctl.signal)
        } catch {
          if (ctl.signal.aborted) return
          continue // keep the lower resolution; nothing else depends on it
        }
        if (ctl.signal.aborted || !current) {
          disposeTexture(tex)
          return
        }
        gl.initTexture(tex) // upload now, outside the render of a frame that needs it
        const old = current[step.map]
        current[step.map] = tex
        gl.domElement.dataset.textures = `${step.map}-${step.res}`
        // Materials re-bind on their next frame; dispose once a few frames have rendered without it.
        afterFrames(3, () => disposeTexture(old))
      }
    }

    loadFirst(0).then(
      (tex) => {
        current = tex
        for (const t of MAPS) gl.initTexture(tex[t])
        setStatus({ state: 'ready', textures: tex, level: '1k' })
        gl.domElement.dataset.textures = '1k'
        onFirstReady?.()
        void upgrade()
      },
      (err: unknown) => {
        if (ctl.signal.aborted) return
        setStatus({ state: 'error', error: err instanceof Error ? err : new Error(String(err)) })
        onFirstReady?.()
      },
    )

    return () => {
      ctl.abort()
      cancelIdle?.()
      if (current) for (const t of MAPS) disposeTexture(current[t])
      current = undefined
    }
    // The tier is decided once per canvas; gl is stable for the canvas' lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl])

  return status
}

function afterFrames(n: number, fn: () => void) {
  if (n <= 0) return fn()
  requestAnimationFrame(() => afterFrames(n - 1, fn))
}
