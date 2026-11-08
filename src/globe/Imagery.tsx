/**
 * Regional imagery painted onto the planet (owner request C3), through the Earth and cloud shaders (chunks.ts PAINT):
 *
 *  - CONTEXT: a sharp regional basemap around the searched place (NASA GIBS Blue Marble Next Generation, 500 m
 *    native, ±360 km at ~0.5 km/px on desktops), fetched once results are in and feathered into the global map. It keeps the
 *    close pass views (the chase and the acquired view, both below the global map's texture floor) crisp.
 *  - DECAL: the selected pass's REAL captured image (a Planetary Computer crop of the Sentinel-2 / Landsat item, or the
 *    GIBS daily mosaic), ±40–300 km around the place, developed exactly at the scan line during a live acquisition
 *    sequence and simply there otherwise (rt.acq.full). The hero's capture ("closest look") is fetched ahead.
 *
 * Every image is fetched and decoded off the critical path (preloadImage: one request per URL for the session, then
 * createImageBitmap), and uploaded at a chosen frame: prefetches and the context patch only through the texture
 * upload gate (textures.ts canUpload: nothing choreographed moving); the selected pass's image as soon as no camera
 * flight is past its first few percent (it must be on the GPU before its scan line arrives). Patches fade in and out
 * (never pop); a pass switch fades the old image out before the new one comes in. Uploaded images stay cached (a few),
 * so swiping back and forth never re-fetches or re-uploads.
 */
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture, Vector4, type WebGLRenderer } from 'three'
import { gibsWmsUrl, preloadImage } from '@/imagery'
import { bboxAround, EARTH_RADIUS_KM } from '@/lib/geo'
import { selectSelectedPass, useApp } from '@/state/store'
import type { CaptureCollection } from '@/types'
import { captureOf, closestLookPass, decalSpecFor, decalUrl } from './acquisition'
import { FRAME, useRuntime, type GlobeRuntime } from './runtime'
import { canUpload } from './textures'

/** The context basemap: half size (km) and the GIBS layer (static; any TIME answers the same composite). */
const CTX_HALF_KM = 360
const CTX_LAYER = 'BlueMarble_NextGeneration'
const CTX_TIME = '2004-08-01'
/** Fades (ms). */
const CTX_FADE_IN = 900
const CTX_FADE_OUT = 400
const DECAL_FADE_IN = 260
const DECAL_FADE_OUT = 280
/** Uploaded decal textures kept (LRU). */
const DECAL_CACHE = 5
/** Results must have been on screen this long before prefetches start (they follow the panel's own images). */
const PREFETCH_DELAY_MS = 1500
/** Fresh-exposure band: this much REAL time of scan behind the line, never thinner than FRESH_MIN_KM. */
const FRESH_S = 0.4
const FRESH_MIN_KM = 3

/**
 * Half extent of the panel's photo (results lib/captures cropSpec: Sentinel-2 ±5 km, Landsat ±7.5 km, daily mosaics
 * ±120 km), marked on the painted image as a hairline square.
 */
function panelHalfKm(c: CaptureCollection): number {
  if (c === 'sentinel-2-l2a') return 5
  if (c === 'landsat-c2-l2') return 7.5
  return 120
}

/** Patch bounds in sphere uv: (u centre, v centre, u width, v height). */
function patchUv(lat: number, lon: number, halfKm: number, out: Vector4): Vector4 {
  const [w, s, e, n] = bboxAround(lat, lon, halfKm)
  return out.set(0.5 + lon / 360, 0.5 + lat / 180, (e - w) / 360, (n - s) / 180)
}

interface Entry {
  url: string
  state: 'loading' | 'decoded' | 'ready' | 'error'
  bitmap?: ImageBitmap
  tex?: Texture
  uv: Vector4
  panelHalf: number
  usedAt: number
}

function createStore(gl: WebGLRenderer, rt: GlobeRuntime) {
  const entries = new Map<string, Entry>()
  let alive = true
  /** The entry for an image, starting its fetch + decode the first time (`uv` is built only then). */
  const load = (url: string, uv: () => Vector4, panelHalf: number): Entry => {
    let e = entries.get(url)
    if (e) return e
    e = { url, state: 'loading', uv: uv(), panelHalf, usedAt: performance.now() }
    entries.set(url, e)
    const entry = e
    const log = (what: string, extra?: unknown) => {
      if (!import.meta.env.DEV && import.meta.env.MODE !== 'inspect') return
      const w = window as unknown as { __imageryLog?: unknown[] }
      ;(w.__imageryLog ??= []).push({ t: Math.round(performance.now()), what, url: url.slice(0, 140), extra })
    }
    log('load')
    preloadImage(url)
      .then((img) => createImageBitmap(img, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
      .then(
        (bmp) => {
          if (!alive) return bmp.close()
          entry.bitmap = bmp
          entry.state = 'decoded'
          log('decoded', [bmp.width, bmp.height])
        },
        (err: unknown) => {
          entry.state = 'error'
          log('error', String(err))
        },
      )
    return e
  }
  /** Upload a decoded entry now (allocates the GPU texture with its mip chain). */
  const upload = (e: Entry) => {
    if (e.state !== 'decoded' || !e.bitmap) return
    const tex = new Texture(e.bitmap)
    tex.flipY = false // row 0 = north (the shader samples accordingly)
    tex.colorSpace = SRGBColorSpace
    tex.generateMipmaps = true
    tex.minFilter = LinearMipmapLinearFilter
    tex.magFilter = LinearFilter
    tex.anisotropy = rt.tier.maxAnisotropy
    tex.needsUpdate = true
    gl.initTexture(tex)
    e.bitmap.close()
    e.bitmap = undefined
    e.tex = tex
    e.state = 'ready'
    if (import.meta.env.DEV || import.meta.env.MODE === 'inspect') {
      const w = window as unknown as { __imageryLog?: unknown[] }
      ;(w.__imageryLog ??= []).push({ t: Math.round(performance.now()), what: 'upload', url: e.url.slice(0, 140), flying: rt.camera.flying, acq: rt.acq.armed })
    }
  }
  /** Keep at most `max` decals that are not in use; dispose the least recently used. */
  const prune = (keep: Set<string>, max: number) => {
    const old = [...entries.values()].filter((e) => !keep.has(e.url)).sort((a, b) => a.usedAt - b.usedAt)
    while (old.length > max) {
      const e = old.shift()!
      e.tex?.dispose()
      e.bitmap?.close()
      entries.delete(e.url)
    }
  }
  /** (Re)activate: StrictMode runs effect cleanups once on mount in development, and the store outlives them. */
  const revive = () => {
    alive = true
  }
  const dispose = () => {
    alive = false
    for (const e of entries.values()) {
      e.tex?.dispose()
      e.bitmap?.close()
    }
    entries.clear()
  }
  return { entries, load, upload, prune, revive, dispose }
}

export function Imagery() {
  const rt = useRuntime()
  const gl = useThree((s) => s.gl)
  const store = useMemo(() => createStore(gl, rt), [gl, rt])
  useEffect(() => {
    store.revive()
    return () => store.dispose()
  }, [store])

  const state = useMemo(
    () => ({
      ctx: null as Entry | null, // bound context patch
      ctxKey: '',
      decal: null as Entry | null, // bound decal (slot A, on top)
      prev: null as Entry | null, // the previous one (slot B), held under A while A fades in
      wantDecal: null as Entry | null,
      prefetch: null as Entry | null,
      prefetchKey: '',
      resultsAt: -1,
      reportSeen: undefined as unknown,
      last: performance.now(),
      // Per-frame lookups, recomputed only when their inputs change (no per-frame allocation).
      placeRef: undefined as unknown,
      placeKey: '',
      ctxEntry: null as Entry | null,
      passRef: undefined as unknown,
      passEntry: null as Entry | null,
    }),
    [],
  )

  useFrame(() => {
    const now = performance.now()
    const dt = Math.min(0.1, Math.max(0, (now - state.last) / 1000))
    state.last = now
    const st = useApp.getState()
    const p = rt.paint
    const acq = rt.acq
    const report = st.report
    const place = report?.place ?? st.place
    const mobile = rt.tier.mobile
    const quiet = canUpload(rt, now)
    const midFlight = rt.camera.flying && rt.camera.progress >= 0.06
    if (st.phase === 'results' && report !== state.reportSeen) {
      state.reportSeen = report
      state.resultsAt = now
    }
    if (st.phase !== 'results') state.resultsAt = -1
    const settledResults = state.resultsAt >= 0 && now - state.resultsAt > PREFETCH_DELAY_MS

    if (place !== state.placeRef) {
      state.placeRef = place
      state.placeKey = place ? `${place.lat.toFixed(4)},${place.lon.toFixed(4)}` : ''
      state.ctxEntry = null
    }
    // ── context basemap: one per place, once results have settled (or a pass is open)
    if (place && (settledResults || st.selectedPassId)) {
      const key = state.placeKey
      if (key !== state.ctxKey) {
        if (!state.ctxEntry) {
          const url = gibsWmsUrl(CTX_LAYER, CTX_TIME, place, { halfSizeKm: CTX_HALF_KM, px: mobile ? 1024 : 1536 })
          state.ctxEntry = store.load(url, () => patchUv(place.lat, place.lon, CTX_HALF_KM, new Vector4()), 0)
        }
        const e = state.ctxEntry
        if (e.state === 'decoded' && quiet) store.upload(e)
        // Bind once the old patch has faded out (below).
        if (e.state === 'ready' && p.uCtxOn.value <= 0) {
          state.ctx = e
          state.ctxKey = key
          p.uCtxMap.value = e.tex!
          p.uCtxUv.value.copy(e.uv)
        }
      }
    }
    const ctxWanted = !!place && !!state.ctx && state.ctxKey === state.placeKey
    if (ctxWanted) p.uCtxOn.value = rt.reducedMotion ? 1 : Math.min(1, p.uCtxOn.value + (dt * 1000) / CTX_FADE_IN)
    else if (p.uCtxOn.value > 0) p.uCtxOn.value = Math.max(0, p.uCtxOn.value - (dt * 1000) / CTX_FADE_OUT)

    // ── decal: the selected pass's capture
    const pass = st.selectedPassId && report ? selectSelectedPass(st) : undefined
    if (pass !== state.passRef) {
      state.passRef = pass
      state.passEntry = null
      const cap = pass && place ? captureOf(report, pass) : undefined
      const spec = cap ? decalSpecFor(cap.collection, mobile) : null
      if (cap && spec && place) {
        state.passEntry = store.load(
          decalUrl(cap, spec),
          () => patchUv(place.lat, place.lon, spec.halfSizeKm, new Vector4()),
          panelHalfKm(cap.collection) / (2 * spec.halfSizeKm),
        )
      }
    }
    let want: Entry | null = null
    if (pass && acq.imaged && acq.passId === pass.id && state.passEntry) {
      want = state.passEntry
      want.usedAt = now
      // The selected image uploads as soon as no flight is mid-way: its scan line may be seconds away.
      if (want.state === 'decoded' && !midFlight) store.upload(want)
    }
    // Prefetch the hero's capture once results have settled (network + decode now, upload when quiet).
    if (settledResults && report) {
      const hero = closestLookPass(report)
      const key = hero ? `${report.generatedAt}:${hero.id}` : ''
      if (hero && key !== state.prefetchKey && place) {
        state.prefetchKey = key
        const cap = captureOf(report, hero)
        const spec = cap ? decalSpecFor(cap.collection, mobile) : null
        if (cap && spec)
          state.prefetch = store.load(
            decalUrl(cap, spec),
            () => patchUv(place.lat, place.lon, spec.halfSizeKm, new Vector4()),
            panelHalfKm(cap.collection) / (2 * spec.halfSizeKm),
          )
      }
    }
    if (state.prefetch && state.prefetch.state === 'decoded' && quiet) store.upload(state.prefetch)
    acq.decalReady = !!want && want.state === 'ready'

    // Crossfade between passes: the bound image moves to slot B (fully developed, underneath) and the new one fades
    // in on top; B leaves once A is in. With nothing to show, A fades out.
    const target = want && want.state === 'ready' ? want : null
    const step = (ms: number) => (rt.reducedMotion ? 1 : (dt * 1000) / ms)
    if (target && state.decal !== target) {
      if (state.decal && p.uDecalOn.value > 0.02) {
        state.prev = state.decal
        p.uDecal2Map.value = state.decal.tex!
        p.uDecal2Uv.value.copy(state.decal.uv)
        p.uDecal2On.value = p.uDecalOn.value * (1 - 0) // keeps its current weight
      }
      state.decal = target
      p.uDecalOn.value = 0
      p.uDecalMap.value = target.tex!
      p.uDecalUv.value.copy(target.uv)
      p.uPanelHalf.value = target.panelHalf
    }
    if (target) {
      p.uDecalOn.value = Math.min(1, p.uDecalOn.value + step(DECAL_FADE_IN))
      if (p.uDecalOn.value >= 1 && p.uDecal2On.value > 0) p.uDecal2On.value = Math.max(0, p.uDecal2On.value - step(DECAL_FADE_OUT))
    } else {
      p.uDecalOn.value = Math.max(0, p.uDecalOn.value - step(DECAL_FADE_OUT))
      p.uDecal2On.value = Math.max(0, p.uDecal2On.value - step(DECAL_FADE_OUT))
      if (p.uDecalOn.value <= 0) {
        state.decal = null
        p.uDecalMap.value = null
      }
    }
    if (p.uDecal2On.value <= 0 && state.prev) {
      state.prev = null
      p.uDecal2Map.value = null
    }

    // Scan line and development.
    p.uScanT0.value.copy(acq.t0)
    p.uScanS.value = acq.scanS
    p.uFull.value = acq.full
    p.uFreshRad.value = Math.max(FRESH_MIN_KM, FRESH_S * acq.speedKmS * acq.rate) / EARTH_RADIUS_KM
    // The global weather layer steps aside for the close views (its texels would be blobs there).
    const altR = rt.camera.altitudeKm / EARTH_RADIUS_KM
    const x = Math.min(1, Math.max(0, (altR - 0.05) / 0.13))
    p.uCloudFade.value = x * x * (3 - 2 * x)

    // Keep a few decals around (the bound one, the wanted one, the hero's).
    if (store.entries.size > DECAL_CACHE + 2) {
      const keep = new Set<string>()
      for (const e of [state.ctx, state.ctxEntry, state.decal, state.prev, state.passEntry, state.prefetch]) if (e) keep.add(e.url)
      store.prune(keep, DECAL_CACHE)
    }
  }, FRAME.scene - 1)

  return null
}
