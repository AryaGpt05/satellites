/**
 * Camera framing: store.camera intents → target poses, for a given viewport.
 *
 * Composition (DESIGN.md §4, §6): the globe is the hero, panels never cover more than 40% of the viewport.
 *  - overview: whole Earth, offset right of centre on desktop so the hero copy breathes on the left; centred
 *    and smaller on phones.
 *  - place / pass / satellite: the subject sits in the space the results panel leaves free — left of the
 *    right-docked panel on desktop, above the bottom sheet on phones.
 * The offsets are lens shifts (NDC), so perspective and the orbit pivot are unchanged.
 */
import { clamp, DEG, EARTH_RADIUS_KM, RAD } from '@/lib/geo'
import type { Pass } from '@/types'
import type { PoseSpec } from './cameraMath'

export interface Viewport {
  width: number
  height: number
}

/** Below this CSS width the layout is the phone layout (matches tokens.css' 760px breakpoint). */
export const PHONE_MAX_W = 760
/** Right-docked results panel: --panel-w + --margin (tokens.css). */
const PANEL_W = 432 + 32
/** Fraction of the viewport height covered by the phone bottom sheet in results. */
const SHEET_FRACTION = 0.46

export const isPhone = (vp: Viewport) => vp.width <= PHONE_MAX_W

/**
 * Vertical field of view. 30° on landscape screens; on portrait screens the horizontal field is held at ≥ 22°
 * so phones don't get a telephoto sliver.
 */
export function fovFor(vp: Viewport): number {
  const aspect = vp.width / Math.max(1, vp.height)
  const minH = 22 * DEG
  const v = 2 * Math.atan(Math.tan(minH / 2) / aspect)
  return Math.max(30 * DEG, v) * RAD
}

/**
 * Range (look-at point on the surface → camera) at which the whole Earth spans `fraction` of the limiting
 * viewport dimension.
 */
export function rangeForEarthFraction(vp: Viewport, fraction: number): number {
  const fov = fovFor(vp) * DEG
  const aspect = vp.width / Math.max(1, vp.height)
  const tanHalf = Math.tan(fov / 2) * Math.min(1, aspect)
  // Apparent angular radius ρ of a unit sphere at distance D: sin ρ = 1/D; want tan ρ = fraction · tanHalf.
  const rho = Math.atan(fraction * tanHalf)
  return 1 / Math.sin(rho) - 1
}

/** Lens shift that centres a subject in the area the results UI leaves free. */
export function resultsShift(vp: Viewport): { shiftX: number; shiftY: number } {
  if (isPhone(vp)) return { shiftX: 0, shiftY: SHEET_FRACTION * 0.92 }
  const free = Math.max(vp.width * 0.6, vp.width - PANEL_W)
  return { shiftX: -(vp.width - free) / vp.width, shiftY: 0 }
}

export function overviewPose(vp: Viewport, lat: number, lon: number): PoseSpec {
  const phone = isPhone(vp)
  return {
    lat,
    lon,
    headingDeg: 0,
    range: rangeForEarthFraction(vp, phone ? 0.82 : 0.74),
    tilt: 0,
    shiftX: phone ? 0 : 0.3,
    shiftY: phone ? 0.06 : 0,
  }
}

/** Width of ground (km) visible across the free area, for regional views. */
function rangeForGroundKm(vp: Viewport, km: number): number {
  const fov = fovFor(vp) * DEG
  const aspect = vp.width / Math.max(1, vp.height)
  // Visible half-width at range r on a flat approximation: r · tan(fov/2) · min(aspect, 1).
  return km / 2 / EARTH_RADIUS_KM / (Math.tan(fov / 2) * Math.min(aspect, 1.25))
}

export function placePose(vp: Viewport, lat: number, lon: number): PoseSpec {
  return {
    lat,
    lon,
    headingDeg: 0,
    range: clamp(rangeForGroundKm(vp, 4200), 0.45, 1.6),
    tilt: 12 * DEG,
    ...resultsShift(vp),
  }
}

/**
 * Oblique view above the place, ~35° tilt, facing along the ground-track heading, so the satellite runs
 * away from the viewer across the place and on toward the horizon. For pointable imagers whose track is
 * off to one side, the look-at point moves a third of the way toward the track so both stay in frame.
 */
export function passPose(vp: Viewport, pass: Pass, place: { lat: number; lon: number }): PoseSpec {
  const closest = pass.track.reduce(
    (best, p) => (Math.abs(p.t - pass.tClosest) < Math.abs(best.t - pass.tClosest) ? p : best),
    pass.track[0] ?? { t: pass.tClosest, lat: place.lat, lon: place.lon, altKm: pass.altitudeKm },
  )
  const k = clamp(pass.groundDistanceKm / 1500, 0, 1) * 0.33
  const lat = place.lat + (closest.lat - place.lat) * k
  let dLon = closest.lon - place.lon
  dLon -= 360 * Math.round(dLon / 360)
  const lon = place.lon + dLon * k
  const spanKm = 3600 + pass.groundDistanceKm * 1.4
  return {
    lat,
    lon,
    headingDeg: pass.headingDeg,
    range: clamp(rangeForGroundKm(vp, spanKm), 0.55, 1.9),
    tilt: 35 * DEG,
    ...resultsShift(vp),
  }
}

/** Chase view: behind and above the satellite, looking along its motion. */
export function satellitePose(
  vp: Viewport,
  sat: { lat: number; lon: number; altKm: number },
  headingDeg: number,
): PoseSpec {
  return {
    lat: sat.lat,
    lon: sat.lon,
    r: 1 + sat.altKm / EARTH_RADIUS_KM,
    headingDeg,
    range: isPhone(vp) ? 0.42 : 0.32,
    tilt: 58 * DEG,
    ...resultsShift(vp),
  }
}

/** User zoom limits (range from the look-at point). */
export const MIN_RANGE = 0.05
export const MAX_RANGE = 12
