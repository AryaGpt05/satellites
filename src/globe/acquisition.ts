/**
 * The acquisition sequence of a selected pass (owner request C): the pure model the scene, the camera and the clock
 * share. Everything is keyed to replay sim time relative to the pass's closest approach (tc), so pausing, rates and
 * the hold during the camera's flight all stay in step.
 *
 *   approach   a FRESH replay (results seeded the clock and entered replay, or switched pass mid-replay) arms the
 *              sequence: the camera chases the spacecraft (CameraDirector), the light curtain sweeps, and the real
 *              image develops onto the Earth exactly at the scan line (Earth shader, uScanS). If the seeded lead
 *              is shorter than MIN_APPROACH_S of real time, the clock rewinds to give the approach room to read.
 *   dive       as the scan line closes on the place (DIVE_KM), the chase tightens from "spacecraft and place" onto
 *              the place itself (diveAt), so the image develops LARGE on screen instead of as a speck.
 *   capture    sim time crosses tc during playback: the shockwave, the reticle lock, the ACQUIRED label, and the
 *              camera's settle into the near-top-down view of the painted image.
 *   settled    no live sweep: the image is simply there (fully developed), the camera rests on the acquired view.
 *              Quiet selections (gallery swipes), scrubbing and reduced motion go straight here.
 *
 * Around tc the replay slows (imaged passes only) so the image paints over ≈ PAINT_REAL_S instead of flashing past:
 * the clock multiplies its replay step by slowFactor().
 */
import { pickLead } from '@/lib/clarity'
import { Vector3 } from 'three'
import { bboxAround, clamp, EARTH_RADIUS_KM, latLonToWorld } from '@/lib/geo'
import type { Capture, CaptureCollection, Pass, Report } from '@/types'

/** Real seconds the approach should take at least (before the capture moment): ~1 s of the wide chase, ~1 s of the
 *  dive onto the place, then the paint up to the capture. */
export const MIN_APPROACH_S = 2.9
/** Real seconds the painting of the decal should take (the slow-motion window around tc). */
export const PAINT_REAL_S = 1.6
/** Slow-motion floor (fraction of the replay rate) and the sim-time ramp into it (s). */
const SLOW_MIN = 0.2
const SLOW_RAMP_S = 12
/** Never rewind before this much sim time ahead of tc (the results replay window pads ±90 s). */
const MAX_LEAD_MS = 88_000
/**
 * On arrival the replay waits at most this long (ms) for the pass's image to reach the GPU (Planetary Computer renders
 * crops in 1–3 s): better a beat of stillness than a sweep that paints nothing. Then it goes regardless.
 */
export const DECAL_WAIT_MS = 1500

export interface AcqState {
  /** Selected pass this state belongs to ('' = none) */
  passId: string
  /** Its closest approach (sim ms) */
  tc: number
  /** A real image exists: the decal paints and the capture moment plays */
  imaged: boolean
  /** A live sequence is running toward the capture (chase camera, sweep-driven paint) */
  armed: boolean
  /** performance.now() when the live sequence was armed / captured (−Infinity before) */
  armedAt: number
  capturedAt: number
  /** 0..1: how far the decal is forced to its developed state (1 = settled; 0 = follows the scan line) */
  full: number
  /** Effective replay rate this frame, sim s per real s (slow motion included) */
  rate: number
  /** Scan geometry: sub-satellite point (p0) and ground-track direction (t0) at tc, unit vectors; ground speed */
  p0: Vector3
  t0: Vector3
  speedKmS: number
  /** Along-track position of the scan line (radians from p0 along t0) this frame */
  scanS: number
  /** Decal half size (km) for this pass's capture (0 = none) */
  halfKm: number
  /** The decal is on the GPU (written by <Imagery/>): the replay waits a moment for it on arrival */
  decalReady: boolean
  /** Where the acquired view centres: the painted image's real data (imageFocus); focusOk once set for this pass */
  focusOk: boolean
  focusLat: number
  focusLon: number
}

export function createAcqState(): AcqState {
  return {
    passId: '',
    tc: 0,
    imaged: false,
    armed: false,
    armedAt: -Infinity,
    capturedAt: -Infinity,
    full: 1,
    rate: 0,
    p0: new Vector3(1, 0, 0),
    t0: new Vector3(0, 1, 0),
    speedKmS: 6.8,
    scanS: 0,
    halfKm: 0,
    decalReady: false,
    focusOk: false,
    focusLat: 0,
    focusLon: 0,
  }
}

// ───────────────────────────── the image painted onto the globe ─────────────────────────────

const isDaily = (c: CaptureCollection) => /^gibs-(viirs|modis)-/.test(c)

/**
 * The decal crop for a capture: large enough to read as a developed strip around the place, small enough that the
 * archive renders it in a second or two. Sentinel-2 items are 110 km tiles, so its crop stays inside one.
 * Geostationary frames are not pass captures (no decal).
 */
export function decalSpecFor(collection: CaptureCollection, mobile: boolean): { halfSizeKm: number; px: number } | null {
  const px = mobile ? 768 : 1024
  if (collection === 'sentinel-2-l2a') return { halfSizeKm: 40, px }
  if (collection === 'landsat-c2-l2') return { halfSizeKm: 45, px }
  if (isDaily(collection)) return { halfSizeKm: 300, px }
  return null
}

/**
 * PC bbox crops come back as JPEG (smaller; no-data is black, keyed out in the shader), as the panel does.
 *
 * Always GEOGRAPHIC (lon/lat, EPSG:4326), even for a scene the panel cuts on its own UTM grid: the decal is drawn on
 * the sphere through a lon/lat patch (Imagery.tsx patchUv: uv linear in longitude and latitude), so a lon/lat image
 * lands exactly with no per-vertex projection in the shader. A grid-cut decal would need the inverse UTM per fragment
 * (or a mesh) to sit right, for nothing: at 78 m per pixel the decal is 8× coarser than the scene, so its warp costs
 * no detail, and its request (~1–2 s) runs while the camera flies.
 */
export function decalUrl(capture: Pick<Capture, 'cropUrl' | 'collection'>, spec: { halfSizeKm: number; px: number }): string {
  const url = capture.cropUrl({ ...spec, geographic: true })
  return /^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/[^?]+\.png\?/.test(url) ? url.replace(/\.png\?/, '.jpg?') : url
}

export function captureOf(report: Pick<Report, 'captures'> | undefined, pass: Pick<Pass, 'captureId'> | undefined): Capture | undefined {
  if (!report || !pass?.captureId) return undefined
  return report.captures.find((c) => c.id === pass.captureId)
}

/** Sun high enough that a daily true-colour mosaic shows the ground (results lib/photos.ts MOSAIC_MIN_SUN_DEG). */
const MOSAIC_MIN_SUN_DEG = 10

type CoverCandidate = { p: Pass; c: Capture }
/** Weather mosaics: sharpest, then a well-lit day, then newest. */
const byMosaic = (a: CoverCandidate, b: CoverCandidate) => {
  const lit = (x: CoverCandidate) => Number((x.p.sunElevationDeg ?? 0) >= MOSAIC_MIN_SUN_DEG)
  return a.c.gsdM - b.c.gsdM || lit(b) - lit(a) || b.p.tClosest - a.p.tClosest
}

/**
 * The pass whose image the results panel leads with (R3-17), so its decal is fetched before anyone opens it. The
 * same pick as results lib/photos.ts windowCover (both rank detailed photos with src/lib/clarity.ts pickLead;
 * acquisition.test.ts checks the two agree): among the window's imaged passes, the most zoomed-in CLEAR detailed
 * capture of the clearest tier present (ties: clear spot, clearer square, higher sun, straighter view, newer); with
 * every detailed capture clouded, the least cloudy one; with none, the sharpest weather mosaic. Only images the globe
 * can paint count; partial reports wait for the final one (the cover can still change).
 */
export function coverPass(report: Report | undefined): Pass | undefined {
  if (!report || report.partial) return undefined
  const detailed: CoverCandidate[] = []
  const mosaics: CoverCandidate[] = []
  const seen = new Set<string>()
  for (const p of report.passes) {
    if (p.verdict !== 'imaged') continue
    const c = captureOf(report, p)
    if (!c || seen.has(c.id)) continue
    seen.add(c.id)
    if (c.provider !== 'gibs') detailed.push({ p, c })
    else if (isDaily(c.collection)) mosaics.push({ p, c })
  }
  const lead = pickLead(detailed.map((x) => ({ x, capture: x.c, t: x.p.tClosest, sunDeg: x.p.sunElevationDeg, offNadirDeg: x.p.offNadirDeg })))
  const pick = lead ? lead.item.x : mosaics.sort(byMosaic)[0]
  return pick && decalSpecFor(pick.c.collection, false) ? pick.p : undefined
}

/** How far the acquired view leans from the place toward the image's data, and how far the place may sit off centre. */
const FOCUS_LEAN = 0.75
const FOCUS_MAX = 0.45

/**
 * Where the settled view centres: the middle of the painted image's REAL data. A Sentinel-2 item is one 110 km tile
 * (Landsat a scene), so near a tile edge part of the crop around the place is no-data (keyed out) and an image
 * centred on the place would sit off to one side. The valid part is the crop square clipped by the capture's
 * footprint; the view leans most of the way toward its centroid, keeping the place within FOCUS_MAX × halfKm of the
 * centre (the reticle stays well inside the frame). Without a usable footprint: the place.
 */
export function imageFocus(
  place: { lat: number; lon: number },
  halfKm: number,
  footprint: [number, number][] | undefined,
): { lat: number; lon: number } {
  if (!footprint || footprint.length < 3 || halfKm <= 0) return { lat: place.lat, lon: place.lon }
  const [w, s, e, n] = bboxAround(place.lat, place.lon, halfKm)
  // Footprint ring as [lon, lat], unwrapped next to the place (no ring spans 180° of longitude).
  let ring = footprint.map(([lon, lat]) => [place.lon + (((lon - place.lon + 540) % 360) - 180), lat] as [number, number])
  if (ring.some(([lon]) => Math.abs(lon - place.lon) > 90)) return { lat: place.lat, lon: place.lon }
  // Sutherland–Hodgman against the crop square.
  const clip = (inside: (p: [number, number]) => boolean, cut: (a: [number, number], b: [number, number]) => [number, number]) => {
    const out: [number, number][] = []
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const ia = inside(a)
      const ib = inside(b)
      if (ia) out.push(a)
      if (ia !== ib) out.push(cut(a, b))
    }
    ring = out
  }
  const atLon = (x: number) => (a: [number, number], b: [number, number]): [number, number] => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])]
  const atLat = (y: number) => (a: [number, number], b: [number, number]): [number, number] => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y]
  clip((p) => p[0] >= w, atLon(w))
  clip((p) => p[0] <= e, atLon(e))
  clip((p) => p[1] >= s, atLat(s))
  clip((p) => p[1] <= n, atLat(n))
  if (ring.length < 3) return { lat: place.lat, lon: place.lon }
  // Area centroid (shoelace), in a local equal-scale frame (longitude shrunk by cos(lat)).
  const k = Math.cos((place.lat * Math.PI) / 180)
  let a2 = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < ring.length; i++) {
    const x0 = (ring[i][0] - place.lon) * k
    const y0 = ring[i][1] - place.lat
    const x1 = (ring[(i + 1) % ring.length][0] - place.lon) * k
    const y1 = ring[(i + 1) % ring.length][1] - place.lat
    const c = x0 * y1 - x1 * y0
    a2 += c
    cx += (x0 + x1) * c
    cy += (y0 + y1) * c
  }
  // A sliver of data is no reason to move.
  const fullA2 = 2 * ((2 * halfKm) / 111.32) ** 2
  if (Math.abs(a2) < 0.08 * fullA2) return { lat: place.lat, lon: place.lon }
  cx /= 3 * a2
  cy /= 3 * a2
  // Lean toward it, the place kept near the middle (in degrees of latitude ≈ km / 111.32).
  let dx = cx * FOCUS_LEAN
  let dy = cy * FOCUS_LEAN
  const maxDeg = (FOCUS_MAX * halfKm) / 111.32
  const d = Math.hypot(dx, dy)
  if (d > maxDeg) {
    dx *= maxDeg / d
    dy *= maxDeg / d
  }
  return { lat: place.lat + dy, lon: place.lon + dx / k }
}

// ───────────────────────────── time ─────────────────────────────

/** Sim seconds either side of tc inside which the replay runs at the slow-motion floor. */
export function slowWindowS(halfKm: number, speedKmS: number): number {
  return halfKm / Math.max(1, speedKmS) + 1
}

/**
 * Replay rate multiplier at sim time `t` (ms): 1 far from tc, easing down to a floor that makes the decal paint over
 * ≈ PAINT_REAL_S of real time, then back up. 1 everywhere when there is no decal.
 */
export function slowFactor(t: number, tc: number, halfKm: number, speedKmS: number, rate: number): number {
  if (halfKm <= 0 || rate <= 0) return 1
  const paintSimS = (2 * halfKm) / Math.max(1, speedKmS)
  const floor = clamp(paintSimS / PAINT_REAL_S / rate, SLOW_MIN, 1)
  if (floor >= 1) return 1
  const w = slowWindowS(halfKm, speedKmS)
  const d = Math.abs(t - tc) / 1000
  const u = clamp((d - w) / SLOW_RAMP_S, 0, 1)
  return floor + (1 - floor) * u * u * (3 - 2 * u)
}

/**
 * Sim start (ms) that gives the approach at least MIN_APPROACH_S of real time before tc at `rate` (slow motion
 * included): the seeded time when it is already early enough, else earlier, never more than MAX_LEAD_MS ahead.
 */
export function approachStart(seeded: number, tc: number, halfKm: number, speedKmS: number, rate: number): number {
  if (seeded >= tc || rate <= 0) return seeded
  let t = tc
  let real = 0
  const dt = 1 / 60
  while (real < MIN_APPROACH_S && tc - t < MAX_LEAD_MS) {
    t -= rate * slowFactor(t, tc, halfKm, speedKmS, rate) * dt * 1000
    real += dt
  }
  return Math.min(seeded, Math.max(t, tc - MAX_LEAD_MS))
}

// ───────────────────────────── scan geometry ─────────────────────────────

const _a = new Vector3()
const _b = new Vector3()

/**
 * The sub-satellite point at tc and the unit ground-track direction there (from the pass's sampled track), into
 * p0 / t0. Along-track positions are then asin(N · t0) radians: the cross-track great circle through p0 is s = 0.
 */
export function scanFrame(pass: Pick<Pass, 'track' | 'tClosest'>, p0: Vector3, t0: Vector3): void {
  const tr = pass.track
  if (tr.length < 2) return
  let i = 0
  while (i < tr.length - 2 && tr[i + 1].t < pass.tClosest) i++
  const p = tr[i]
  const q = tr[i + 1]
  const f = clamp((pass.tClosest - p.t) / Math.max(1, q.t - p.t), 0, 1)
  latLonToWorld(p.lat, p.lon, 1, _a)
  latLonToWorld(q.lat, q.lon, 1, _b)
  p0.copy(_a).lerp(_b, f).normalize()
  t0.copy(_b).sub(_a)
  t0.addScaledVector(p0, -t0.dot(p0))
  if (t0.lengthSq() < 1e-18) t0.set(0, 1, 0)
  t0.normalize()
}

/** Along-track position (radians from p0) of the scan line at sim time t: the sub-satellite point moves at ground speed. */
export const scanAt = (t: number, tc: number, speedKmS: number) => (((t - tc) / 1000) * speedKmS) / EARTH_RADIUS_KM

/**
 * The dive: along-track distance (km) of the scan line from the place where the chase starts tightening onto the
 * place, and where it is fully on it (before the image's leading edge starts to paint).
 */
export const DIVE_KM = { far: 210, near: 55 }

/**
 * How far the chase has dived onto the place at sim time t (0 = the wide spacecraft-and-place chase, 1 = on the
 * place), smootherstep in the scan line's distance. Only for images small enough to need it (not daily mosaics).
 */
export function diveAt(t: number, tc: number, speedKmS: number, halfKm: number): number {
  if (halfKm <= 0 || halfKm > 100) return 0
  const d = (Math.abs(t - tc) / 1000) * speedKmS
  const u = clamp((DIVE_KM.far - d) / (DIVE_KM.far - DIVE_KM.near), 0, 1)
  return Math.min(1, u * u * u * (u * (6 * u - 15) + 10))
}

/** Format a countdown to tc in sim time: "T−00:01:12" / "T+00:00:03". */
export function fmtCountdown(simTime: number, tc: number): string {
  const d = Math.round((simTime - tc) / 1000)
  const a = Math.abs(d)
  const hh = String(Math.floor(a / 3600)).padStart(2, '0')
  const mm = String(Math.floor((a % 3600) / 60)).padStart(2, '0')
  const ss = String(a % 60).padStart(2, '0')
  return `T${d < 0 ? '−' : '+'}${hh}:${mm}:${ss}`
}
