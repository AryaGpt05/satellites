/**
 * The acquisition sequence of a selected pass (owner request C): the pure model the scene, the camera and the clock
 * share. Everything is keyed to replay sim time relative to the pass's closest approach (tc), so pausing, rates and
 * the hold during the camera's flight all stay in step.
 *
 *   approach   a FRESH replay (results seeded the clock and entered replay, or switched pass mid-replay) arms the
 *              sequence: the camera chases the spacecraft (CameraDirector), the light curtain sweeps, and the real
 *              image develops onto the Earth exactly at the scan line (Earth shader, uScanS). If the seeded lead
 *              is shorter than MIN_APPROACH_S of real time, the clock rewinds to give the approach room to read.
 *   capture    sim time crosses tc during playback: the shockwave, the reticle lock, the ACQUIRED label, and the
 *              camera's settle into the near-top-down view of the painted image.
 *   settled    no live sweep: the image is simply there (fully developed), the camera rests on the acquired view.
 *              Quiet selections (gallery swipes), scrubbing and reduced motion go straight here.
 *
 * Around tc the replay slows (imaged passes only) so the image paints over ≈ PAINT_REAL_S instead of flashing past:
 * the clock multiplies its replay step by slowFactor().
 */
import { Vector3 } from 'three'
import { clamp, EARTH_RADIUS_KM, latLonToWorld } from '@/lib/geo'
import type { Capture, CaptureCollection, Pass, Report } from '@/types'

/** Real seconds the approach should take at least (before the capture moment). */
export const MIN_APPROACH_S = 2.4
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

/** PC bbox crops come back as JPEG (smaller; no-data is black, keyed out in the shader), as the panel does. */
export function decalUrl(capture: Pick<Capture, 'cropUrl' | 'collection'>, spec: { halfSizeKm: number; px: number }): string {
  const url = capture.cropUrl(spec)
  return /^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/[^?]+\.png\?/.test(url) ? url.replace(/\.png\?/, '.jpg?') : url
}

export function captureOf(report: Pick<Report, 'captures'> | undefined, pass: Pick<Pass, 'captureId'> | undefined): Capture | undefined {
  if (!report || !pass?.captureId) return undefined
  return report.captures.find((c) => c.id === pass.captureId)
}

/**
 * The capture the hero shows first (owner request B: the most zoomed-in image; ties → most recent), so its decal can
 * be fetched before anyone opens it.
 */
export function closestLookPass(report: Report | undefined): Pass | undefined {
  if (!report || report.partial) return undefined
  let best: { p: Pass; gsd: number; clear: number } | undefined
  for (const p of report.passes) {
    if (p.verdict !== 'imaged') continue
    const c = captureOf(report, p)
    if (!c || !decalSpecFor(c.collection, false)) continue
    const clear = SPOT_RANK[c.spot ?? 'unknown']
    const better =
      !best || c.gsdM < best.gsd || (c.gsdM === best.gsd && (clear < best.clear || (clear === best.clear && p.tClosest > best.p.tClosest)))
    if (better) best = { p, gsd: c.gsdM, clear }
  }
  return best?.p
}

/** Spot clarity order (owner request B1): clear > cirrus > unknown > shadow > cloud. */
const SPOT_RANK: Record<string, number> = { clear: 0, cirrus: 1, unknown: 2, shadow: 3, cloud: 4 }

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

/** Format a countdown to tc in sim time: "T−00:01:12" / "T+00:00:03". */
export function fmtCountdown(simTime: number, tc: number): string {
  const d = Math.round((simTime - tc) / 1000)
  const a = Math.abs(d)
  const hh = String(Math.floor(a / 3600)).padStart(2, '0')
  const mm = String(Math.floor((a % 3600) / 60)).padStart(2, '0')
  const ss = String(a % 60).padStart(2, '0')
  return `T${d < 0 ? '−' : '+'}${hh}:${mm}:${ss}`
}
