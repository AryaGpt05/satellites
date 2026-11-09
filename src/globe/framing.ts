/**
 * Camera framing: store.camera intents → target poses, for a given viewport AND the UI that covers it.
 *
 * The UI measures what it covers and publishes it as store.uiInsets (CSS px per edge): the HUD the top, the
 * landing column the left (desktop) or bottom (stacked), the results panel / sheet / timeline the right and
 * bottom. Every pose frames its subject inside the free rect those insets leave:
 *
 *   F = { x0: left, y0: top, x1: W − right, y1: H − bottom }
 *
 * Offsets are lens shifts (NDC), so perspective and the orbit pivot are unchanged. The subject lands at
 * screen ((x0 + x1) / 2, (y0 + y1) / 2), i.e. shiftX = (x0 + x1) / W − 1 and shiftY = 1 − (y0 + y1) / H.
 *
 * Composition (DESIGN.md §4, §6; product decisions 3, 4, 6):
 *  - overview, stacked: the whole globe AND its LEO point halo fit the band above the landing panel with ≥ 12 px
 *    to spare; desktop: the globe sits right of centre and the halo never reaches the text column.
 *  - place / pass / satellite: the subject is centred in F; regional ranges are measured against F.
 *  - the pass view is north-up (oblique ~35°), never south-up by default.
 *  - no pose (and no user zoom) goes closer than the loaded day texture can resolve (minRangeFor).
 */
import { PerspectiveCamera, Vector3 } from 'three'
import { clamp, DEG, EARTH_RADIUS_KM, RAD } from '@/lib/geo'
import { isStacked } from '@/lib/layout'
import type { UiInsets } from '@/state/store'
import type { Pass } from '@/types'
import { applyPoseToCamera, createPose, makePose, type PoseSpec } from './cameraMath'

export interface Viewport {
  width: number
  height: number
}

export type Insets = UiInsets
export const NO_INSETS: Readonly<Insets> = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })

/** Stacked (phone-like) layout: the shared predicate from src/lib/layout.ts. */
export const isPhone = (vp: Viewport) => isStacked(vp.width, vp.height)

/** World radius (Earth radii) that the overview keeps inside the frame: the dense LEO / Starlink shells. */
export const HALO_R = 1.18
/** Gap kept between the halo and the panel below it on stacked layouts (decision 4). */
export const HALO_GAP_PX = 12

// ───────────────────────────── free rect ─────────────────────────────

export interface FreeRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * The part of the viewport the UI leaves free. Never inverted; a fully covered axis collapses to a 1 px line.
 * Writes into `out` when given (allocation-free for per-frame callers).
 */
export function freeRect(vp: Viewport, insets: Insets = NO_INSETS, out?: FreeRect): FreeRect {
  const W = Math.max(1, vp.width)
  const H = Math.max(1, vp.height)
  let x0 = clamp(insets.left, 0, W)
  let x1 = clamp(W - insets.right, 0, W)
  let y0 = clamp(insets.top, 0, H)
  let y1 = clamp(H - insets.bottom, 0, H)
  if (x1 - x0 < 1) {
    const m = clamp((x0 + x1) / 2, 0.5, W - 0.5)
    x0 = m - 0.5
    x1 = m + 0.5
  }
  if (y1 - y0 < 1) {
    const m = clamp((y0 + y1) / 2, 0.5, H - 0.5)
    y0 = m - 0.5
    y1 = m + 0.5
  }
  if (!out) return { x0, y0, x1, y1 }
  out.x0 = x0
  out.y0 = y0
  out.x1 = x1
  out.y1 = y1
  return out
}

/** Lens shift that centres a subject in the free rect. */
export function freeShift(vp: Viewport, insets: Insets = NO_INSETS): { shiftX: number; shiftY: number } {
  const f = freeRect(vp, insets)
  return { shiftX: (f.x0 + f.x1) / Math.max(1, vp.width) - 1, shiftY: 1 - (f.y0 + f.y1) / Math.max(1, vp.height) }
}

// ───────────────────────────── lens ─────────────────────────────

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

/** CSS px per unit of tan(angle off the optical axis); the same horizontally and vertically for a pinhole. */
const pxPerTan = (vp: Viewport) => vp.height / 2 / Math.tan((fovFor(vp) * DEG) / 2)

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

/** Apparent radius (CSS px) of a centred sphere of radius `r` seen from distance `dist` (exact for a pinhole). */
export function spherePx(vp: Viewport, r: number, dist: number): number {
  const rho = Math.asin(Math.min(1, r / Math.max(dist, r * 1.000001)))
  return Math.tan(rho) * pxPerTan(vp)
}

/** Camera distance (from Earth's centre) at which a sphere of radius `r` appears `radiusPx` CSS px in radius. */
export function distanceForSpherePx(vp: Viewport, r: number, radiusPx: number): number {
  const t = Math.max(1e-4, radiusPx / pxPerTan(vp))
  return r / Math.sin(Math.atan(t))
}

/**
 * Range at which `km` of ground spans the free rect. The span is measured across F's limiting dimension, with
 * wide rects capped at 1.25 × their height, so a short free band (a raised sheet, a timeline) pulls the camera
 * back instead of cropping the region. Flat approximation at the look-at point.
 */
export function rangeForGroundKm(vp: Viewport, f: FreeRect, km: number): number {
  const spanPx = Math.max(24, Math.min(f.x1 - f.x0, 1.25 * (f.y1 - f.y0)))
  return (km / EARTH_RADIUS_KM) * (pxPerTan(vp) / spanPx)
}

// ───────────────────────────── texture-resolution floor (decision 6) ─────────────────────────────

/** Width in texels of the equirectangular day map at each level. */
export const TEXTURE_WIDTH = { '1k': 1024, '2k': 2048, '4k': 4096, '8k': 8192 } as const
export type TextureLevel = keyof typeof TEXTURE_WIDTH

/** Ground km per texel of the day map at the equator (1k 39 km, 2k 19.6, 4k 9.8, 8k 4.9). */
export const kmPerTexel = (level: TextureLevel) => 40075 / TEXTURE_WIDTH[level]

const LEVELS: TextureLevel[] = ['1k', '2k', '4k', '8k']
/** The coarser of two levels. */
export const coarserLevel = (a: TextureLevel, b: TextureLevel): TextureLevel => (LEVELS.indexOf(a) <= LEVELS.indexOf(b) ? a : b)

/** At most this many CSS px per texel at the look-at point: closer than that the surface reads as a blur. */
export const MAX_PX_PER_TEXEL = 2.5

/**
 * The closest range (look-at on the surface → camera) at which the day map still has a texel for every
 * MAX_PX_PER_TEXEL CSS px. Monotonic: a finer level always allows a closer camera.
 */
export function minRangeFor(vp: Viewport, level: TextureLevel): number {
  const kmPerPx = kmPerTexel(level) / MAX_PX_PER_TEXEL
  return (kmPerPx / EARTH_RADIUS_KM) * pxPerTan(vp)
}

// ───────────────────────────── poses ─────────────────────────────

/**
 * Whole Earth, north-up.
 *  - Stacked: the halo (HALO_R) spans min(W − 56, band − 24) and is centred in the free band, so the globe and
 *    its point cloud sit above the landing panel with ≥ 12 px to spare (decision 4).
 *  - Desktop: 74% of the height, right of centre (shiftX 0.3) so the hero copy breathes; pushed further right
 *    (and if it must, made smaller) so the halo's left edge clears insets.left (the text column), while the disc
 *    itself stays OVERVIEW_RIGHT_MARGIN inside whatever covers the right edge (the halo may bleed past the bezel).
 */
/** Desktop overview: the disc's minimum distance from the right edge (or whatever covers it), CSS px. */
export const OVERVIEW_RIGHT_MARGIN = 40

export function overviewPose(vp: Viewport, insets: Insets, lat: number, lon: number): PoseSpec {
  const W = Math.max(1, vp.width)
  const H = Math.max(1, vp.height)
  if (isPhone(vp)) {
    const f = freeRect(vp, insets)
    const band = f.y1 - f.y0
    const haloD = Math.max(96, Math.min(W - 56, band - 2 * HALO_GAP_PX))
    const dist = distanceForSpherePx(vp, HALO_R, haloD / 2)
    const cy = (f.y0 + f.y1) / 2
    return { lat, lon, headingDeg: 0, range: dist - 1, tilt: 0, shiftX: 0, shiftY: 1 - (2 * cy) / H }
  }

  let fraction = 0.74
  let range = rangeForEarthFraction(vp, fraction)
  let er = spherePx(vp, 1, 1 + range)
  let hr = spherePx(vp, HALO_R, 1 + range)
  let cx = 0.65 * W
  if (insets.left > 0 || insets.right > 0) {
    const lo = insets.left
    const hi = W - insets.right - OVERVIEW_RIGHT_MARGIN
    // Shrink until halo-left-of-centre + disc-right-of-centre fits between the column and the right edge.
    for (let i = 0; i < 4 && hr + er > hi - lo && hi - lo > 0; i++) {
      fraction *= (hi - lo) / (hr + er)
      range = rangeForEarthFraction(vp, fraction)
      er = spherePx(vp, 1, 1 + range)
      hr = spherePx(vp, HALO_R, 1 + range)
    }
    cx = clamp(cx, lo + hr, Math.max(lo + hr, hi - er))
  }
  return { lat, lon, headingDeg: 0, range, tilt: 0, shiftX: (2 * cx) / W - 1, shiftY: 0 }
}

// ───────────────────────────── limb vs. the TR clock ─────────────────────────────

/**
 * The HUD's top-right readout block (UTC clock + scene time) on desktop, CSS px, grown by `margin` so the limb
 * keeps a little air around the text.
 */
export function trReadoutBox(vp: Viewport, margin = 0) {
  return { x0: vp.width - 320 - margin, x1: vp.width - 16 + margin, y0: 16 - margin, y1: 80 + margin }
}

const _cam = new PerspectiveCamera()
const _pose = createPose()
const _c = new Vector3()
const _u = new Vector3()
const _w = new Vector3()
const _p = new Vector3()

/**
 * True when the Earth's limb (the bright atmosphere rim), as seen from the camera for `spec`, crosses the box.
 * Samples the silhouette circle and projects it through the real camera (lens shift included).
 */
export function limbCrossesBox(vp: Viewport, spec: PoseSpec, box: { x0: number; x1: number; y0: number; y1: number }, n = 240): boolean {
  applyPoseToCamera(makePose(spec, _pose), _cam, vp, fovFor(vp))
  const d = _cam.position.length()
  _c.copy(_cam.position).normalize()
  const rad = Math.sqrt(Math.max(0, 1 - 1 / (d * d)))
  _u.set(0, 1, 0).cross(_c)
  if (_u.lengthSq() < 1e-9) _u.set(1, 0, 0).cross(_c)
  _u.normalize()
  _w.copy(_c).cross(_u)
  _c.multiplyScalar(1 / d)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI
    _p.copy(_c).addScaledVector(_u, rad * Math.cos(a)).addScaledVector(_w, rad * Math.sin(a)).project(_cam)
    if (_p.z <= -1 || _p.z >= 1) continue
    const x = ((_p.x + 1) / 2) * vp.width
    const y = ((1 - _p.y) / 2) * vp.height
    if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) return true
  }
  return false
}

// ───────────────────────────── place ─────────────────────────────

/** Ground span of the regional place view (km across the free rect). */
export const PLACE_SPAN_KM = 4200
const PLACE_RANGE = { min: 0.45, max: 1.6, clearMax: 2.1 }
const PLACE_TILT = { stacked: 12 * DEG, desktop: 8 * DEG }

/**
 * Regional view above the place, north-up, slightly oblique. `minRange` is the texture-resolution floor.
 * On desktop the bright limb must stay clear of the TR clock (V12, G14): with the place centred left of the
 * dock, the limb crosses the clock for ranges between ~0.8 and ~1.4, and closer than that is below the 4k
 * texture floor, so the range steps out until the limb passes left of / below the readout block.
 */
export function placePose(vp: Viewport, insets: Insets, lat: number, lon: number, minRange = 0): PoseSpec {
  const stacked = isPhone(vp)
  const spec: PoseSpec = {
    lat,
    lon,
    headingDeg: 0,
    range: Math.max(clamp(rangeForGroundKm(vp, freeRect(vp, insets), PLACE_SPAN_KM), PLACE_RANGE.min, PLACE_RANGE.max), minRange),
    tilt: stacked ? PLACE_TILT.stacked : PLACE_TILT.desktop,
    ...freeShift(vp, insets),
  }
  if (!stacked) {
    const box = trReadoutBox(vp, 8)
    const r0 = spec.range
    while (spec.range < PLACE_RANGE.clearMax && limbCrossesBox(vp, spec, box)) spec.range += 0.025
    if (spec.range >= PLACE_RANGE.clearMax) spec.range = r0 // no clear range: keep the regional framing
  }
  return spec
}

/** The pass view's tilt (decision 3: oblique ~35°, north-up). */
export const PASS_TILT = 35 * DEG

/**
 * Oblique view above the place, ~35° tilt, NORTH-UP (decision 3): the camera sits south of the place looking
 * north, so maps read the way people know them and the (mostly north–south) ground track runs up the screen.
 * For pointable imagers whose track is off to one side, the look-at point moves a third of the way toward the
 * track so both stay in frame.
 */
export function passPose(vp: Viewport, insets: Insets, pass: Pass, place: { lat: number; lon: number }, minRange = 0): PoseSpec {
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
    headingDeg: 0,
    range: Math.max(clamp(rangeForGroundKm(vp, freeRect(vp, insets), spanKm), 0.55, 1.9), minRange),
    tilt: PASS_TILT,
    ...freeShift(vp, insets),
  }
}

// ───────────────────────────── acquisition sequence (owner request C) ─────────────────────────────

/** Chase tilt during the approach (oblique, north-up: a gentle chase, never a yaw swing). */
export const CHASE_TILT = { stacked: 46 * DEG, desktop: 52 * DEG }
/** Share of the free rect's limiting span that the spacecraft-to-place distance fills in the chase. */
const CHASE_FILL = 0.6
/** At the end of the dive: the tilt, and the share of the free rect's span the painted image fills. */
export const DIVE_TILT = { stacked: 36 * DEG, desktop: 40 * DEG }
const DIVE_FILL = 0.5
/** Share of the free rect's limiting span the painted image fills in the acquired view. */
const ACQ_FILL = 0.5
/** The acquired view's tilt: near top-down, so the globe's image lines up with the panel's (north-up). */
export const ACQ_TILT = 5 * DEG

const _s = new Vector3()
const _m = new Vector3()
const _f = new Vector3()

/**
 * The approach: an oblique north-up view whose look-at sits halfway between the place (on the ground) and the
 * spacecraft (in orbit), at the range that fits both, so the spacecraft, its light curtain and the place all read
 * while the camera glides along with the pass. `satWorld` is the spacecraft's world position (Earth radii).
 *
 * `dive` (0..1, acquisition.diveAt) tightens it onto the image as the scan line closes in: the look-at slides down to
 * `focus` (the painted image's centre, acquisition.imageFocus; the place by default), the range comes in until the
 * image (2 × halfKm) fills DIVE_FILL of the free rect, and the tilt eases toward DIVE_TILT. The spacecraft leaves the
 * top of the frame and its curtain comes down onto the image.
 */
export function chasePose(
  vp: Viewport,
  insets: Insets,
  satWorld: Vector3,
  place: { lat: number; lon: number },
  dive = 0,
  halfKm = 0,
  focus: { lat: number; lon: number } = place,
): PoseSpec {
  const stacked = isPhone(vp)
  const f = freeRect(vp, insets)
  latLonToDir(place.lat, place.lon, _s)
  _m.copy(_s).add(satWorld).multiplyScalar(0.5)
  const dKm = _s.distanceTo(satWorld) * EARTH_RADIUS_KM
  let range = clamp(rangeForGroundKm(vp, f, dKm / CHASE_FILL), 0.1, 1.6)
  let tilt = stacked ? CHASE_TILT.stacked : CHASE_TILT.desktop
  const k = halfKm > 0 ? clamp(dive, 0, 1) : 0
  if (k > 0) {
    _m.lerp(latLonToDir(focus.lat, focus.lon, _f), k)
    const tight = Math.min(range, rangeForGroundKm(vp, f, (2 * halfKm) / DIVE_FILL))
    range = Math.exp(Math.log(range) + (Math.log(tight) - Math.log(range)) * k)
    tilt += ((stacked ? DIVE_TILT.stacked : DIVE_TILT.desktop) - tilt) * k
  }
  const r = _m.length()
  const lat = Math.asin(clamp(_m.y / r, -1, 1)) * RAD
  const lon = Math.atan2(-_m.z, _m.x) * RAD
  return {
    lat,
    lon,
    r,
    headingDeg: 0,
    range,
    tilt,
    ...freeShift(vp, insets),
  }
}

/**
 * The settled view of an imaged pass: near top-down, north-up, centred on the place, framing the image painted onto
 * the globe (2 × halfKm square). It may come closer than the base map's floor: the painted image (and the regional
 * basemap patch under it) carry the detail there.
 */
export function acquiredPose(vp: Viewport, insets: Insets, place: { lat: number; lon: number }, halfKm: number): PoseSpec {
  return {
    lat: place.lat,
    lon: place.lon,
    headingDeg: 0,
    range: clamp(rangeForGroundKm(vp, freeRect(vp, insets), (2 * halfKm) / ACQ_FILL), 0.02, 1.9),
    tilt: ACQ_TILT,
    ...freeShift(vp, insets),
  }
}

function latLonToDir(lat: number, lon: number, out: Vector3): Vector3 {
  const la = lat * DEG
  const lo = lon * DEG
  const c = Math.cos(la)
  return out.set(c * Math.cos(lo), Math.sin(la), -c * Math.sin(lo))
}

/** Chase view: behind and above the satellite, looking along its motion. */
export function satellitePose(
  vp: Viewport,
  insets: Insets,
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
    ...freeShift(vp, insets),
  }
}

/** Absolute user zoom limits (range from the look-at point). The effective near limit is minRangeFor(level). */
export const MIN_RANGE = 0.05
export const MAX_RANGE = 12
