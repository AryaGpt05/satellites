import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { DEG, RAD } from '@/lib/geo'
import type { Pass } from '@/types'
import { applyPoseToCamera, makePose, type PoseSpec } from './cameraMath'
import {
  fovFor,
  freeRect,
  freeShift,
  HALO_GAP_PX,
  HALO_R,
  minRangeFor,
  OVERVIEW_RIGHT_MARGIN,
  overviewPose,
  passPose,
  placePose,
  rangeForEarthFraction,
  type Insets,
  type TextureLevel,
  type Viewport,
} from './framing'

const desktop: Viewport = { width: 1440, height: 900 }
const laptop: Viewport = { width: 1280, height: 800 }
const phone: Viewport = { width: 390, height: 844 }
const small: Viewport = { width: 360, height: 740 }
const tablet: Viewport = { width: 768, height: 1024 }
const ins = (p: Partial<Insets>): Insets => ({ top: 0, right: 0, bottom: 0, left: 0, ...p })

/** Render a pose spec through a real camera and project world points to CSS px. */
function cameraFor(vp: Viewport, spec: PoseSpec) {
  const cam = new PerspectiveCamera()
  applyPoseToCamera(makePose(spec), cam, vp, fovFor(vp))
  const project = (p: Vector3) => {
    const v = p.clone().project(cam)
    return { x: ((v.x + 1) / 2) * vp.width, y: ((1 - v.y) / 2) * vp.height, front: v.z > -1 && v.z < 1 }
  }
  return { cam, project }
}

/** Silhouette (as seen from the camera) of a centred sphere of radius r, projected; front points only. */
function silhouette(vp: Viewport, spec: PoseSpec, r: number, n = 720) {
  const { cam, project } = cameraFor(vp, spec)
  const C = cam.position.clone()
  const d = C.length()
  const axis = C.clone().normalize()
  const centre = axis.clone().multiplyScalar((r * r) / d)
  const rad = r * Math.sqrt(1 - (r * r) / (d * d))
  const u = new Vector3(0, 1, 0).cross(axis)
  if (u.lengthSq() < 1e-9) u.set(1, 0, 0).cross(axis)
  u.normalize()
  const w = axis.clone().cross(u).normalize()
  const pts: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI
    const p = centre.clone().addScaledVector(u, rad * Math.cos(a)).addScaledVector(w, rad * Math.sin(a))
    const s = project(p)
    if (s.front) pts.push(s)
  }
  return pts
}

const bounds = (pts: { x: number; y: number }[]) => ({
  minX: Math.min(...pts.map((p) => p.x)),
  maxX: Math.max(...pts.map((p) => p.x)),
  minY: Math.min(...pts.map((p) => p.y)),
  maxY: Math.max(...pts.map((p) => p.y)),
})

/** Screen position of the pose's look-at subject. */
function subjectPx(vp: Viewport, spec: PoseSpec) {
  const { project } = cameraFor(vp, spec)
  const la = spec.lat * DEG
  const lo = spec.lon * DEG
  const r = spec.r ?? 1
  return project(new Vector3(Math.cos(la) * Math.cos(lo) * r, Math.sin(la) * r, -Math.cos(la) * Math.sin(lo) * r))
}

describe('fovFor', () => {
  it('is 30° on landscape screens', () => {
    expect(fovFor(desktop)).toBeCloseTo(30, 9)
  })
  it('holds at least 22° horizontally on portrait screens', () => {
    const v = fovFor(phone) * DEG
    const h = 2 * Math.atan(Math.tan(v / 2) * (phone.width / phone.height))
    expect(h * RAD).toBeCloseTo(22, 6)
    expect(fovFor(phone)).toBeGreaterThan(30)
  })
})

describe('rangeForEarthFraction', () => {
  for (const vp of [desktop, phone]) {
    it(`makes the Earth span the requested fraction (${vp.width}×${vp.height})`, () => {
      const r = rangeForEarthFraction(vp, 0.74)
      const D = 1 + r
      const rho = Math.asin(1 / D)
      const tanHalf = Math.tan((fovFor(vp) * DEG) / 2) * Math.min(1, vp.width / vp.height)
      expect(Math.tan(rho) / tanHalf).toBeCloseTo(0.74, 9)
    })
  }
})

describe('free rect', () => {
  it('centres the subject in what the UI leaves free', () => {
    const vp = desktop
    const i = ins({ top: 72, right: 500, bottom: 200 })
    const { shiftX, shiftY } = freeShift(vp, i)
    expect(((shiftX + 1) / 2) * vp.width).toBeCloseTo((1440 - 500) / 2, 6)
    expect(((1 - shiftY) / 2) * vp.height).toBeCloseTo((72 + 700) / 2, 6)
  })
  it('never inverts when the UI covers everything', () => {
    const f = freeRect(phone, ins({ top: 64, bottom: 900 }))
    expect(f.y1).toBeGreaterThan(f.y0)
    expect(f.y0).toBeGreaterThanOrEqual(0)
  })
})

describe('overview (decision 4)', () => {
  // (a) and (b): the halo sits fully inside the band between the HUD and the landing panel, ≥ 12 px clear.
  for (const [vp, i] of [
    [phone, ins({ top: 64, bottom: 377 })],
    [small, ins({ top: 64, bottom: 368 })],
    [tablet, ins({ top: 64, bottom: 420 })],
  ] as const) {
    it(`fits the globe and its halo above the landing panel (${vp.width}×${vp.height})`, () => {
      const spec = overviewPose(vp, i, 20, 0)
      const halo = bounds(silhouette(vp, spec, HALO_R))
      expect(halo.minY).toBeGreaterThanOrEqual(i.top - 0.5)
      expect(halo.maxY).toBeLessThanOrEqual(vp.height - i.bottom - HALO_GAP_PX + 0.5)
      expect(halo.minX).toBeGreaterThanOrEqual(0)
      expect(halo.maxX).toBeLessThanOrEqual(vp.width)
      // Whole disc visible and as large as the band allows (the halo is ~1.19× the disc).
      const earth = bounds(silhouette(vp, spec, 1))
      const band = vp.height - i.bottom - i.top
      expect(earth.maxX - earth.minX).toBeGreaterThan(0.8 * Math.min(vp.width - 56, band - 24) / 1.2)
    })
  }

  it('matches the plan’s numbers at 390×844 (D ≈ 283 px, centre ≈ 265, shiftY ≈ 0.37)', () => {
    const spec = overviewPose(phone, ins({ top: 64, bottom: 377 }), 20, 0)
    const earth = bounds(silhouette(phone, spec, 1))
    expect(earth.maxX - earth.minX).toBeGreaterThan(270)
    expect(earth.maxX - earth.minX).toBeLessThan(295)
    expect((earth.minY + earth.maxY) / 2).toBeCloseTo(265.5, 0)
    expect(spec.shiftY!).toBeCloseTo(0.371, 2)
  })

  // (c): the point cloud never overlaps the desktop text column.
  for (const [vp, left] of [
    [desktop, 640],
    [laptop, 600],
    [{ width: 1024, height: 700 }, 560],
  ] as const) {
    it(`keeps the halo right of the text column (${vp.width}×${vp.height}, left ${left})`, () => {
      const spec = overviewPose(vp, ins({ top: 72, left }), 20, 0)
      const halo = bounds(silhouette(vp, spec, HALO_R))
      const earth = bounds(silhouette(vp, spec, 1))
      expect(halo.minX).toBeGreaterThanOrEqual(left - 0.5)
      expect(earth.maxX).toBeLessThanOrEqual(vp.width - OVERVIEW_RIGHT_MARGIN + 0.5)
    })
  }

  it('keeps the classic right-of-centre composition before the landing measures itself', () => {
    expect(overviewPose(desktop, ins({}), 20, 0).shiftX).toBeCloseTo(0.3, 9)
    expect(overviewPose(phone, ins({}), 20, 0).shiftX).toBe(0)
  })
})

const pass = (over: Partial<Pass>): Pass => ({
  id: 'x',
  norad: 1,
  tClosest: 1000,
  tStart: 0,
  tEnd: 2000,
  groundDistanceKm: 0,
  offNadirDeg: 0,
  elevationDeg: 90,
  azimuthDeg: 0,
  altitudeKm: 786,
  groundSpeedKmS: 6.9,
  headingDeg: 192,
  node: 'descending',
  sunElevationDeg: 30,
  inSwath: true,
  inFieldOfRegard: true,
  verdict: 'imaged',
  track: [{ t: 1000, lat: 43.47, lon: -80.54, altKm: 786 }],
  ...over,
})

describe('place / pass subjects sit in the free band', () => {
  const place = { lat: 43.47, lon: -80.54 }
  // (d): the reticle is centred in the visible band for every sheet snap, never under the grip.
  for (const bottom of [200, 377, 590, 776]) {
    const i = ins({ top: 64, bottom })
    it(`place at 390×844, sheet bottom ${bottom}`, () => {
      const s = subjectPx(phone, placePose(phone, i, place.lat, place.lon))
      expect(s.y).toBeGreaterThanOrEqual(64)
      expect(s.y).toBeLessThanOrEqual(844 - bottom)
      expect(s.y).toBeCloseTo((64 + 844 - bottom) / 2, 0)
      expect(s.x).toBeCloseTo(195, 0)
    })
    it(`pass at 390×844, sheet bottom ${bottom}`, () => {
      const spec = passPose(phone, i, pass({}), place)
      const s = subjectPx(phone, spec)
      expect(s.y).toBeGreaterThanOrEqual(64)
      expect(s.y).toBeLessThanOrEqual(844 - bottom)
    })
  }

  it('centres the desktop subject left of the dock and above the timeline', () => {
    const i = ins({ top: 72, right: 500, bottom: 200 })
    const s = subjectPx(laptop, placePose(laptop, i, place.lat, place.lon))
    expect(s.x).toBeCloseTo((1280 - 500) / 2, 0)
    expect(s.y).toBeCloseTo((72 + 600) / 2, 0)
  })

  it('pulls back when the free band shrinks', () => {
    const lo = placePose(phone, ins({ top: 64, bottom: 377 }), place.lat, place.lon)
    const hi = placePose(phone, ins({ top: 64, bottom: 590 }), place.lat, place.lon)
    expect(hi.range).toBeGreaterThanOrEqual(lo.range)
  })
})

describe('passPose (decision 3: north-up)', () => {
  it('looks north at ~35° tilt, above the place, whatever the track heading', () => {
    for (const headingDeg of [12, 192, 260]) {
      const p = passPose(desktop, ins({}), pass({ headingDeg }), { lat: 43.47, lon: -80.54 })
      expect(p.headingDeg).toBe(0)
      expect(p.tilt! * RAD).toBeCloseTo(35, 9)
      expect(p.lat).toBeCloseTo(43.47, 9)
      expect(p.lon).toBeCloseTo(-80.54, 9)
    }
  })

  it('moves the look-at toward an off-track satellite (pointable imagers)', () => {
    const p = passPose(desktop, ins({}), pass({ groundDistanceKm: 1500, track: [{ t: 1000, lat: 43.47, lon: -62, altKm: 500 }] }), {
      lat: 43.47,
      lon: -80.54,
    })
    expect(p.lon).toBeGreaterThan(-80.54)
    expect(p.lon).toBeLessThan(-70)
  })

  it('takes the short way across the antimeridian', () => {
    const p = passPose(desktop, ins({}), pass({ groundDistanceKm: 1500, track: [{ t: 1000, lat: 0, lon: -179, altKm: 500 }] }), {
      lat: 0,
      lon: 179,
    })
    expect(Math.abs(p.lon)).toBeGreaterThan(179)
  })
})

describe('place view keeps the limb out of the TR clock (G14)', () => {
  // Results insets as the shell publishes them: HUD top, the right dock, the timeline strip.
  for (const [vp, i] of [
    [laptop, ins({ top: 72, right: 504, bottom: 0 })],
    [laptop, ins({ top: 72, right: 504, bottom: 196 })],
    [desktop, ins({ top: 72, right: 504, bottom: 196 })],
    [desktop, ins({ top: 72, right: 504, bottom: 0 })],
  ] as const) {
    it(`${vp.width}×${vp.height} (bottom ${i.bottom})`, () => {
      for (const lat of [-60, -20, 0, 43.47, 70]) {
        const spec = placePose(vp, i, lat, -80.54, minRangeFor(vp, '4k'))
        const limb = silhouette(vp, spec, 1, 1440)
        const box = { x0: vp.width - 320, x1: vp.width - 16, y0: 16, y1: 80 }
        const hits = limb.filter((p) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1)
        expect(hits.length).toBe(0)
      }
    })
  }
})

describe('texture-resolution floor (decision 6)', () => {
  const levels: TextureLevel[] = ['1k', '2k', '4k', '8k']
  for (const vp of [desktop, phone]) {
    it(`decreases monotonically as the level rises (${vp.width}×${vp.height})`, () => {
      const r = levels.map((l) => minRangeFor(vp, l))
      for (let k = 1; k < r.length; k++) expect(r[k]).toBeLessThan(r[k - 1])
    })
  }
  it('never shows more than 2.5 CSS px per texel', () => {
    const vp = desktop
    const r = minRangeFor(vp, '4k')
    // km per CSS px at the look-at point for this range
    const kmPerPx = ((2 * r * Math.tan((fovFor(vp) * DEG) / 2)) / vp.height) * 6371
    expect((40075 / 4096) / kmPerPx).toBeCloseTo(2.5, 6)
  })
  it('is respected by the scripted place pose', () => {
    const floor = minRangeFor(desktop, '1k')
    expect(placePose(desktop, ins({}), 0, 0, floor).range).toBeGreaterThanOrEqual(floor)
  })
})
