/**
 * Progressive Earth textures.
 *
 *   1k set (day, night, clouds, data; ~0.2 MB) → first frame → globeReady
 *   → phones:   day 2k first, then night / clouds 2k at landing idle; day 4k once the camera has arrived at a place
 *               or pass
 *   → desktops: day 4k first, then night / clouds / data 4k at landing idle; day 8k (capable desktops) once the first
 *               results have settled with no pass open
 *
 * The FIRST day step sets the zoom floor a regional view needs (decision 6), so it is on the critical path of the
 * first flight: it skips the idle wait, and on a deep link or share link (?q= / ?s=) its download starts when this
 * module evaluates (one request, one decode, handed to the upgrade through decodedMap). A deep link to a place that
 * is in darkness right now adds the first NIGHT step to that critical path (on the night side the floor is the
 * coarser of the two maps: CameraDirector). Once the critical steps are on the GPU, store.dayMapSharp turns true
 * (once per page; at first light if the plan has none).
 *
 * Nothing is uploaded while anything choreographed is moving (decision 9, PERF-01). Fetch and decode happen off the
 * main thread (fetch → createImageBitmap); the UPLOAD waits for canUpload():
 *   boot        allowed: the curtain covers the globe;
 *   computing   only while the place flight has barely started (eased progress < 0.04, the camera has hardly
 *               moved) or once it has been parked for 300 ms, so a sharper map lands before the flight's range
 *               matters and the flight carries the new floor (CameraDirector folds it into the landing);
 *   otherwise   no camera flight, ≥ 600 ms since arrival, ≥ 2 s into the phase;
 *   always      past store.motionBusyUntil (UI entrances; in computing, a hold left over from the previous phase's
 *               UI does not count), not in the first 10 s of a replay sweep (the signature moment), tab visible.
 * Uploads are sliced: the destination is allocated once (texStorage only), then 256-row strips are uploaded
 * straight into it with texSubImage2D (4 strips for 2k, 8 for 4k, 16 for 8k; no intermediate texture and no GL
 * state queries), one per frame, or several within a small time budget under the boot curtain and in computing's
 * windows (uploadBudgetMs); mips are generated once after the last strip, and only then is the finished texture
 * swapped in. The texture it replaces is disposed a few frames later. Colour maps are sRGB; the cloud and data maps are data
 * (no conversion).
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
  type WebGLRenderer,
} from 'three'
import { latLonToWorld, sunDirectionWorld } from '@/lib/geo'
import { useApp } from '@/state/store'
import type { TextureLevel } from './framing'
import { detectMobile, provisionalTier, type QualityTier } from './quality'
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

function bitmapsSupported(): boolean {
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

/** Uploads hold off for this long after a replay sweep starts (capped, so an endless replay can't starve them). */
export const REPLAY_QUIET_MS = 10_000

/** True when a GPU upload can't hitch anything the user is watching (see the header). */
export function canUpload(rt: GlobeRuntime, now: number): boolean {
  const st = useApp.getState()
  if (st.phase === 'computing') {
    const early = rt.camera.flying && rt.camera.progress < 0.04 // first part of an ease-in-out flight: the camera has barely moved
    const parked = !rt.camera.flying && now - rt.camera.arrivedAt > 300
    if (!early && !parked) return false
  } else if (st.phase !== 'boot') {
    // boot: the curtain covers the globe
    if (rt.camera.flying || now - rt.camera.arrivedAt <= 600) return false
    if (now - rt.phaseEnteredAt <= 2000) return false
  }
  // In computing, a hold set before the phase began belongs to UI that has already gone (the landing's entrance).
  const inherited = st.phase === 'computing' && st.motionBusyUntil <= rt.phaseBusyFloor
  if (now <= st.motionBusyUntil && !inherited) return false
  if (st.timeMode === 'replay' && now - rt.replayStartedAt < REPLAY_QUIET_MS) return false
  return typeof document === 'undefined' || !document.hidden
}

// ───────────────────────────── decode (off the main thread), memoised ─────────────────────────────

const BITMAP_OPTS: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }

/**
 * One upload strip: RGBA bytes the strip owns, never an ImageBitmap. On iOS WebKit an ImageBitmap cropped from another
 * (createImageBitmap(full, x, y, w, h, { imageOrientation: 'flipY' })) can share its source's backing store and come
 * out with the wrong rows, and texSubImage2D(ImageBitmap) is copied later in the GPU process: closing the source and the
 * strip right after the call let that memory be recycled first, so the iPhone's day / night maps held stale rendered
 * frames (space, satellite dots, a smaller globe) wrapped around the planet. Bytes are copied by texSubImage2D itself.
 */
interface TexStrip {
  width: number
  height: number
  data: Uint8Array | null
  close(): void
}

let stripSurface: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null

/** Source rows [y, y + rows) of `img` as RGBA bytes, flipped vertically when `flip` (drawn flipped, never via FLIP_Y). */
function stripBytes(img: ImageBitmap, y: number, rows: number, flip: boolean): Uint8Array {
  const w = img.width
  const c0 = stripSurface
  if (!c0 || c0.canvas.width !== w || c0.canvas.height !== rows) {
    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, rows) : Object.assign(document.createElement('canvas'), { width: w, height: rows })
    stripSurface = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!stripSurface) throw new Error('texture strip: no 2D context')
  }
  const c = stripSurface!
  c.imageSmoothingEnabled = false
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.clearRect(0, 0, w, rows)
  if (flip) c.setTransform(1, 0, 0, -1, 0, rows)
  c.drawImage(img, 0, y, w, rows, 0, 0, w, rows)
  const px = c.getImageData(0, 0, w, rows).data
  return new Uint8Array(px.buffer, px.byteOffset, px.byteLength)
}

function makeStrip(width: number, height: number, data: Uint8Array): TexStrip {
  const s: TexStrip = { width, height, data, close: () => void (s.data = null) }
  return s
}

async function fetchDecode(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Texture ${url}: HTTP ${res.status}`)
  return createImageBitmap(await res.blob(), BITMAP_OPTS)
}

/** Maps whose download + decode started early (a deep link), by URL. Each is handed to the upgrade once. */
const decoded = new Map<string, Promise<ImageBitmap>>()

/** Start the download + decode of a map now (idempotent); the upgrade picks it up instead of fetching again. */
export function prefetchMap(map: EarthMap, res: Exclude<TextureLevel, '1k'>): void {
  const url = textureUrl(map, res)
  if (decoded.has(url)) return
  const p = fetchDecode(url)
  p.catch(() => undefined) // a failed prefetch is retried by whoever takes it
  decoded.set(url, p)
}

/** The decoded bitmap for a map: the prefetched one when there is one (taken, so it is never reused), else a fresh load. */
function decodedMap(map: EarthMap, res: TextureLevel, signal: AbortSignal): Promise<ImageBitmap> {
  const url = textureUrl(map, res)
  const p = decoded.get(url)
  if (!p) return fetchDecode(url, signal)
  decoded.delete(url)
  return p.catch(() => fetchDecode(url, signal))
}

/** Release prefetched bitmaps the real tier's plan has no use for (the provisional tier guessed differently). */
function dropUnplanned(plan: UpgradeStep[]) {
  const keep = new Set(plan.map((st) => textureUrl(st.map, st.res)))
  for (const [url, p] of decoded) {
    if (keep.has(url)) continue
    decoded.delete(url)
    p.then((b) => b.close(), () => undefined)
  }
}

/** The step that sharpens the day map first (the regional zoom floor), if the plan has one. */
export const firstDayStep = (plan: UpgradeStep[]) => plan.find((st) => st.map === 'day')

/** A deep link's place (`?q=lat,lon`), when the URL names one. */
export function deepLinkPlace(search: string): { lat: number; lon: number } | undefined {
  const q = new URLSearchParams(search).get('q')
  const m = q?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)
  if (!m) return undefined
  const lat = Number(m[1])
  const lon = Number(m[2])
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : undefined
}

/** On the night side at `t`, by the camera's own rule (CameraDirector: the floor follows the night map there). */
export function inDarkAt(place: { lat: number; lon: number }, t: number): boolean {
  return latLonToWorld(place.lat, place.lon, 1).dot(sunDirectionWorld(t)) <= 0.1
}

/**
 * The steps the first regional view waits on (the zoom floor): the first day step, and on a deep link to a place
 * that is in darkness right now, the first night step too (there the floor is the coarser of the two maps). They
 * skip the idle wait, cut every strip up front, and store.dayMapSharp turns true once they have all landed.
 */
export function criticalSteps(plan: UpgradeStep[], dark: boolean): UpgradeStep[] {
  const day = firstDayStep(plan)
  const night = dark ? plan.find((st) => st.map === 'night') : undefined
  return [day, night].filter((st): st is UpgradeStep => !!st)
}

const DEEP_LINK = typeof location !== 'undefined' ? deepLinkPlace(location.search) : undefined
const DEEP_DARK = !!DEEP_LINK && inDarkAt(DEEP_LINK, Date.now())

// A deep link or share link goes from boot straight to a regional view: fetch the maps it needs now, while the boot
// runs (the provisional tier: the GL context does not exist yet; dropUnplanned undoes a wrong guess).
if (typeof location !== 'undefined' && (/[?&](q|s)=/.test(location.search) || /^\/s\//.test(location.pathname)) && bitmapsSupported()) {
  for (const st of criticalSteps(upgradePlan(provisionalTier(detectMobile())), DEEP_DARK)) prefetchMap(st.map, st.res)
}

// ───────────────────────────── upload ─────────────────────────────

/**
 * Upload one strip straight into the destination texture (bound through three's state cache, unpack state set
 * through it too, so three's own later uploads see what is really set). The strip's bytes were cut already flipped
 * (GL rows run south → north) and are copied by the call itself. The last strip generates the mip chain.
 */
function uploadStrip(gl: WebGLRenderer, dst: Texture, strip: TexStrip, y: number, last: boolean) {
  if (!strip.data) throw new Error('texture strip already released')
  const g = gl.getContext() as WebGL2RenderingContext
  const props = gl.properties.get(dst) as { __webglTexture?: WebGLTexture }
  if (!props.__webglTexture) gl.initTexture(dst)
  const tex = (gl.properties.get(dst) as { __webglTexture: WebGLTexture }).__webglTexture
  const state = gl.state
  state.activeTexture(g.TEXTURE0)
  state.bindTexture(g.TEXTURE_2D, tex)
  state.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false)
  state.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  state.pixelStorei(g.UNPACK_ALIGNMENT, 4)
  state.pixelStorei(g.UNPACK_ROW_LENGTH, 0)
  state.pixelStorei(g.UNPACK_SKIP_PIXELS, 0)
  state.pixelStorei(g.UNPACK_SKIP_ROWS, 0)
  g.texSubImage2D(g.TEXTURE_2D, 0, 0, y, strip.width, strip.height, g.RGBA, g.UNSIGNED_BYTE, strip.data)
  if (last) g.generateMipmap(g.TEXTURE_2D)
  if (import.meta.env.DEV) {
    const err = g.getError()
    if (err !== g.NO_ERROR) console.error(`[globe] texture strip upload at row ${y}: GL error 0x${err.toString(16)}`)
  }
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
 * Time budget (ms) for upload jobs in one frame: normally one job per frame (0 = just the first); while the boot
 * curtain covers the globe, or in computing's windows (the camera has barely moved, or is parked), a frame may take
 * several, so the critical day map lands even on a slow device.
 */
export function uploadBudgetMs(phase: string): number {
  return phase === 'boot' ? 24 : phase === 'computing' ? 12 : 0
}

/**
 * Frame-synchronous scheduler: conditions are checked once per frame, and upload jobs run only while the upload
 * gate is open: the first queued job, then more while the frame's budget lasts.
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
    tick(gateOpen: boolean, budgetMs = 0) {
      for (let i = waits.length - 1; i >= 0; i--) {
        if (waits[i].pred()) waits.splice(i, 1)[0].resolve()
      }
      if (!gateOpen) return
      const t0 = performance.now()
      while (jobs.length) {
        const j = jobs.shift()!
        try {
          j.fn()
          j.resolve()
        } catch (e) {
          j.reject(e)
        }
        if (performance.now() - t0 >= budgetMs) break
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

  // Poll conditions and run upload slices (one per frame, more only where the budget allows), before the scene renders.
  useFrame(() => sched.tick(canUpload(rt, performance.now()), uploadBudgetMs(useApp.getState().phase)), FRAME.clock)

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
      // The big step (8k day) never starts while a pass is open: it waits for the user to come back to the list.
      return when === 'idle' || (when === 'place' && placeSeen) || (when === 'results' && resultsSeen && !useApp.getState().selectedPassId)
    }

    /**
     * Fetch + decode off-thread (or take the deep-link prefetch), then upload strip by strip; resolves with the
     * finished texture. `eager` (the first day step, on the critical path): every strip is cut up front, so a frame
     * with upload budget can take several; otherwise each strip is cut just before its upload (less memory).
     */
    const buildSliced = async (step: UpgradeStep, eager: boolean): Promise<Texture> => {
      const full = await decodedMap(step.map, step.res, ctl.signal)
      if (ctl.signal.aborted) {
        full.close()
        throw new DOMException('Aborted', 'AbortError')
      }
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
      const n = Math.ceil(H / STRIP_ROWS)
      // GL rows [y, y + rows) count from the bottom (south) up; image rows run north → south, so they are image
      // rows [H − y − rows, H − y), flipped.
      const cut = async (i: number) => {
        const y = i * STRIP_ROWS
        const rows = Math.min(STRIP_ROWS, H - y)
        const strip = makeStrip(W, rows, stripBytes(full, H - y - rows, rows, true))
        pending.add(strip)
        return strip
      }
      const done = (strip: TexStrip) => {
        pending.delete(strip)
        strip.close()
      }
      const abortIfNeeded = () => {
        if (ctl.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      }
      try {
        if (eager) {
          const cuts = await Promise.allSettled(Array.from({ length: n }, (_, i) => cut(i)))
          const strips = cuts.flatMap((c) => (c.status === 'fulfilled' ? [c.value] : []))
          pending.delete(full)
          full.close() // the strips hold the pixels now
          if (strips.length < n) {
            strips.forEach(done)
            throw new Error(`Texture ${textureUrl(step.map, step.res)}: strip decode failed`)
          }
          abortIfNeeded()
          // The first job allocates the storage (uploadStrip inits the texture), the last generates the mips.
          await Promise.all(
            strips.map((strip, i) => sched.upload(() => uploadStrip(gl, dst, strip, i * STRIP_ROWS, i === n - 1)).finally(() => done(strip))),
          )
        } else {
          await sched.upload(() => gl.initTexture(dst))
          for (let i = 0; i < n; i++) {
            abortIfNeeded()
            const strip = await cut(i)
            try {
              await sched.upload(() => uploadStrip(gl, dst, strip, i * STRIP_ROWS, i === n - 1))
            } finally {
              done(strip)
            }
          }
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

    const plan = upgradePlan(tier)
    const critical = criticalSteps(plan, DEEP_DARK)
    /** store.dayMapSharp: once per page, when the maps the first regional view needs are sharper than the boot level. */
    const markSharp = () => {
      const st = useApp.getState()
      if (!st.dayMapSharp) st.setDayMapSharp(true)
    }
    const waiting = new Set(critical)
    const landed = (step: UpgradeStep) => {
      if (waiting.delete(step) && waiting.size === 0) markSharp()
    }

    const upgrade = async () => {
      const bitmaps = bitmapsSupported()
      dropUnplanned(plan)
      for (const step of plan) {
        if (ctl.signal.aborted || !current) return
        await sched.waitUntil(ready(step.when))
        // Start fetching in an idle slot (the upload is gated separately), except the critical steps: the first
        // regional view waits on them.
        const isCritical = critical.includes(step)
        if (!isCritical) {
          await new Promise<void>((r) => {
            cancelIdle = idle(r)
          })
        }
        let tex: Texture
        try {
          tex = bitmaps ? await buildSliced(step, isCritical) : await buildWhole(step)
        } catch {
          if (ctl.signal.aborted) return
          landed(step) // nothing sharper will come from it: do not hold the first view on it
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
        landed(step)
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
        if (!critical.length) markSharp() // nothing sharper will come: first light is as sharp as it gets
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
