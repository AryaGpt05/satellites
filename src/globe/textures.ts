/**
 * Progressive Earth textures.
 *
 *   1k set (day, night, clouds, data; ~0.2 MB) → first frame → globeReady
 *   → phones:   day / night / clouds 2k at landing idle; day 4k once the camera has arrived at a place or pass
 *   → desktops: day / night / clouds / data 4k at landing idle; day 8k (capable desktops) after the first results
 *
 * Nothing is uploaded while anything choreographed is moving (decision 9, PERF-01). Fetch and decode happen
 * off the main thread (fetch → createImageBitmap); the UPLOAD waits for canUpload():
 *   no camera flight, ≥ 600 ms since arrival, not booting or computing, ≥ 2 s into the phase, past
 *   store.motionBusyUntil (UI entrances), tab visible.
 * Uploads are sliced: the destination is allocated once (texStorage only), then one 256-row strip is copied per
 * frame (4 strips for 2k, 8 for 4k, 16 for 8k) with copyTextureToTexture, mips are generated once after the last
 * strip, and only then is the finished texture swapped in. The texture it replaces is disposed a few frames later.
 * Colour maps are sRGB; the cloud and data maps are data (no conversion).
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  UnsignedByteType,
  Vector2,
  type WebGLRenderer,
} from 'three'
import { useApp } from '@/state/store'
import type { TextureLevel } from './framing'
import type { QualityTier } from './quality'
import { FRAME, type GlobeRuntime } from './runtime'

export type EarthMap = 'day' | 'night' | 'clouds' | 'data'
export type EarthTextures = Record<EarthMap, Texture>

export type TextureStatus =
  | { state: 'loading' }
  | { state: 'ready'; textures: EarthTextures }
  | { state: 'error'; error: Error }

const BASE = '/textures/'
export const textureUrl = (map: EarthMap, res: TextureLevel) => `${BASE}earth-${map}-${res}.webp`
const SIZE: Record<TextureLevel, [number, number]> = { '1k': [1024, 512], '2k': [2048, 1024], '4k': [4096, 2048], '8k': [8192, 4096] }
/** Rows per uploaded strip. */
export const STRIP_ROWS = 256

function useBitmaps(): boolean {
  if (typeof createImageBitmap === 'undefined' || typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const safari = /^((?!chrome|android).)*safari/i.test(ua)
  const safariVersion = safari ? Number(ua.match(/Version\/(\d+)/)?.[1] ?? 0) : -1
  const firefox = ua.includes('Firefox')
  const firefoxVersion = firefox ? Number(ua.match(/Firefox\/(\d+)/)?.[1] ?? 0) : -1
  return !((safari && safariVersion < 17) || (firefox && firefoxVersion < 98))
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

/** Load one map as an image-backed texture (the 1k set, and the upgrade path for browsers without bitmaps). */
export function loadMap(map: EarthMap, res: TextureLevel, anisotropy: number, signal?: AbortSignal): Promise<Texture> {
  return new Promise<Texture>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    // Image elements without a crossOrigin attribute (same-origin) reuse index.html's <link rel=preload>.
    const loader = new TextureLoader()
    loader.setCrossOrigin(undefined as unknown as string)
    loader.load(
      textureUrl(map, res),
      (tex) => {
        if (signal?.aborted) {
          tex.dispose()
          return reject(new DOMException('Aborted', 'AbortError'))
        }
        configure(tex, map, anisotropy)
        resolve(tex)
      },
      undefined,
      (e: unknown) => reject(e instanceof Error ? e : new Error(`Texture ${textureUrl(map, res)} failed to load`)),
    )
  })
}

/** Free GPU + decoded image memory. */
function disposeTexture(tex: Texture) {
  const img = tex.image as { close?: () => void } | undefined
  tex.dispose()
  img?.close?.()
}

const MAPS: EarthMap[] = ['day', 'night', 'clouds', 'data']

/**
 * When a step may start:
 *  idle    — at once (the upload itself still waits for canUpload, i.e. landing idle)
 *  place   — after the camera has first arrived at a place or pass (regional views need it, the landing doesn't)
 *  results — after the first results view has settled
 */
export type StepWhen = 'idle' | 'place' | 'results'
export interface UpgradeStep {
  map: EarthMap
  res: Exclude<TextureLevel, '1k'>
  when: StepWhen
}

/**
 * Which maps get upgraded, in order, for a device tier (PERF-09, decision 9).
 *  - Phones: 2k day / night / clouds at landing idle (≈ 8 MB each on the GPU, display-resolution for a ~330 px
 *    globe); day 4k only once a place is on screen; clouds stay 2k and the elevation / ocean mask stays 1k.
 *  - Desktops: the 4k set at landing idle; the 8k day map only after the first results, never on the landing.
 */
export function upgradePlan(tier: QualityTier): UpgradeStep[] {
  if (tier.mobile) {
    const plan: UpgradeStep[] = [
      { map: 'day', res: '2k', when: 'idle' },
      { map: 'night', res: '2k', when: 'idle' },
      { map: 'clouds', res: '2k', when: 'idle' },
    ]
    if (tier.allow4k) plan.push({ map: 'day', res: '4k', when: 'place' })
    return plan
  }
  if (!tier.allow4k) {
    return [
      { map: 'day', res: '2k', when: 'idle' },
      { map: 'night', res: '2k', when: 'idle' },
      { map: 'clouds', res: '2k', when: 'idle' },
    ]
  }
  const plan: UpgradeStep[] = [
    { map: 'day', res: '4k', when: 'idle' },
    { map: 'night', res: '4k', when: 'idle' },
    { map: 'clouds', res: '4k', when: 'idle' },
    { map: 'data', res: '4k', when: 'idle' },
  ]
  if (tier.allow8k) plan.push({ map: 'day', res: '8k', when: 'results' })
  return plan
}

/** Number of strips a map of this level is uploaded in. */
export const stripCount = (res: TextureLevel) => Math.max(1, SIZE[res][1] / STRIP_ROWS)

/** True when a GPU upload can't hitch anything the user is watching (see the header). */
export function canUpload(rt: GlobeRuntime, now: number): boolean {
  const st = useApp.getState()
  if (rt.camera.flying || now - rt.camera.arrivedAt <= 600) return false
  if (st.phase === 'boot' || st.phase === 'computing') return false
  if (now - rt.phaseEnteredAt <= 2000) return false
  if (now <= st.motionBusyUntil) return false
  return typeof document === 'undefined' || !document.hidden
}

const idle = (fn: () => void, timeout = 4000): (() => void) => {
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
 * Frame-synchronous scheduler: conditions are checked once per frame, and at most ONE upload job runs per frame,
 * only while the upload gate is open.
 */
function createScheduler() {
  const waits: { pred: () => boolean; resolve: () => void }[] = []
  const jobs: { fn: () => void; resolve: () => void; reject: (e: unknown) => void }[] = []
  return {
    waitUntil(pred: () => boolean): Promise<void> {
      return new Promise((resolve) => waits.push({ pred, resolve }))
    },
    upload(fn: () => void): Promise<void> {
      return new Promise((resolve, reject) => jobs.push({ fn, resolve, reject }))
    },
    tick(gateOpen: boolean) {
      for (let i = waits.length - 1; i >= 0; i--) {
        if (waits[i].pred()) waits.splice(i, 1)[0].resolve()
      }
      if (gateOpen && jobs.length) {
        const j = jobs.shift()!
        try {
          j.fn()
          j.resolve()
        } catch (e) {
          j.reject(e)
        }
      }
    },
    clear() {
      waits.length = 0
      jobs.length = 0
    },
  }
}

/**
 * React binding (inside the Canvas). Returns the current texture set. Upgrades mutate it in place (same object,
 * a new Texture per key); materials re-bind by identity in their frame callback, so a replaced texture is never
 * referenced by the time it is disposed (three frames later). Writes rt.textureLevel / rt.nightLevel when the day
 * or night map changes.
 */
export function useEarthTextures(gl: WebGLRenderer, rt: GlobeRuntime, onFirstReady?: () => void): TextureStatus {
  const [status, setStatus] = useState<TextureStatus>({ state: 'loading' })
  const sched = useMemo(createScheduler, [])

  // Poll conditions and run at most one upload slice per frame, before the scene renders.
  useFrame(() => sched.tick(canUpload(rt, performance.now())), FRAME.clock)

  useEffect(() => {
    const ctl = new AbortController()
    const tier = rt.tier
    let cancelIdle: (() => void) | undefined
    let current: EarthTextures | undefined
    const pending = new Set<{ close?: () => void }>()

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

    // Step conditions, from what the camera last settled on (CameraDirector records the arrived intent's kind,
    // so this holds however late the scheduler polls: a deep link's place arrival can happen while an earlier
    // step is still uploading). Both are latches: once seen, the step may start.
    let placeSeen = false
    let resultsSeen = false
    const settledAtPlace = (now: number) =>
      !rt.camera.flying &&
      (rt.camera.arrivedKind === 'place' || rt.camera.arrivedKind === 'pass') &&
      now - rt.camera.arrivedAt > 600
    const ready = (when: StepWhen) => () => {
      const now = performance.now()
      if (!placeSeen && settledAtPlace(now)) placeSeen = true
      if (!resultsSeen && useApp.getState().phase === 'results' && now - rt.phaseEnteredAt > 600 && settledAtPlace(now)) resultsSeen = true
      return when === 'idle' || (when === 'place' && placeSeen) || (when === 'results' && resultsSeen)
    }

    /** Fetch + decode off-thread, then upload strip by strip; resolves with the finished texture. */
    const buildSliced = async (step: UpgradeStep): Promise<Texture> => {
      const res = await fetch(textureUrl(step.map, step.res), { signal: ctl.signal })
      if (!res.ok) throw new Error(`Texture ${textureUrl(step.map, step.res)}: HTTP ${res.status}`)
      const blob = await res.blob()
      const opts: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }
      const full = await createImageBitmap(blob, opts)
      pending.add(full)
      const W = full.width
      const H = full.height
      const dst = new DataTexture(null, W, H, RGBAFormat, UnsignedByteType)
      configure(dst, step.map, tier.maxAnisotropy)
      dst.flipY = false
      dst.unpackAlignment = 4
      // Allocate storage (all mip levels) without uploading or generating anything yet.
      dst.mipmapsAutoUpdate = false
      dst.source.dataReady = false
      dst.needsUpdate = true
      try {
        await sched.upload(() => gl.initTexture(dst))
        const n = Math.ceil(H / STRIP_ROWS)
        const at = new Vector2()
        for (let i = 0; i < n; i++) {
          if (ctl.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          const y = i * STRIP_ROWS // GL rows from the bottom (south) up
          const rows = Math.min(STRIP_ROWS, H - y)
          // Image rows run north → south, so GL rows [y, y + rows) are image rows [H − y − rows, H − y), flipped.
          const strip = await createImageBitmap(full, 0, H - y - rows, W, rows, { ...opts, imageOrientation: 'flipY' })
          pending.add(strip)
          const src = new Texture(strip)
          await sched.upload(() => {
            // The last strip also generates the mip chain, once.
            if (i === n - 1) dst.mipmapsAutoUpdate = true
            gl.copyTextureToTexture(src, dst, null, at.set(0, y))
          })
          pending.delete(strip)
          strip.close()
        }
      } catch (e) {
        dst.dispose()
        throw e
      } finally {
        pending.delete(full)
        full.close()
      }
      dst.source.dataReady = true
      return dst
    }

    /** Old browsers without reliable ImageBitmap: one image texture, uploaded in a single (gated) call. */
    const buildWhole = async (step: UpgradeStep): Promise<Texture> => {
      const tex = await loadMap(step.map, step.res, tier.maxAnisotropy, ctl.signal)
      await sched.upload(() => gl.initTexture(tex))
      return tex
    }

    const upgrade = async () => {
      const bitmaps = useBitmaps()
      for (const step of upgradePlan(tier)) {
        if (ctl.signal.aborted || !current) return
        await sched.waitUntil(ready(step.when))
        // Start fetching in an idle slot; the upload is gated separately.
        await new Promise<void>((r) => {
          cancelIdle = idle(r)
        })
        let tex: Texture
        try {
          tex = bitmaps ? await buildSliced(step) : await buildWhole(step)
        } catch {
          if (ctl.signal.aborted) return
          continue // keep the lower resolution; nothing else depends on it
        }
        if (ctl.signal.aborted || !current) {
          disposeTexture(tex)
          return
        }
        const old = current[step.map]
        current[step.map] = tex
        if (step.map === 'day') rt.textureLevel = step.res
        if (step.map === 'night') rt.nightLevel = step.res
        gl.domElement.dataset.textures = `${step.map}-${step.res}`
        // Materials re-bind on their next frame; dispose once a few frames have rendered without it.
        afterFrames(3, () => disposeTexture(old))
      }
    }

    loadFirst(0).then(
      (tex) => {
        current = tex
        for (const t of MAPS) gl.initTexture(tex[t])
        rt.textureLevel = '1k'
        rt.nightLevel = '1k'
        setStatus({ state: 'ready', textures: tex })
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
      sched.clear()
      for (const b of pending) b.close?.()
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
