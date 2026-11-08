import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { DEG } from '@/lib/geo'
import {
  createPose,
  cubicBezier,
  easeInOut,
  headingOf,
  interpolatePose,
  latLonOfDir,
  makePose,
  planFlight,
  poseToCamera,
  FLIGHT_MAX_S,
  FLIGHT_MIN_S,
} from './cameraMath'

const near = (a: Vector3, b: Vector3, eps = 1e-9) => a.distanceTo(b) < eps

describe('pose geometry', () => {
  it('looks straight down at the look-at point with north up when tilt = 0', () => {
    const p = makePose({ lat: 43.46, lon: -80.52, range: 0.5 })
    const pos = new Vector3()
    const up = new Vector3()
    const target = new Vector3()
    poseToCamera(p, pos, up, target)
    expect(target.length()).toBeCloseTo(1, 12)
    expect(pos.length()).toBeCloseTo(1.5, 12)
    // camera directly above the target
    expect(pos.clone().normalize().dot(target)).toBeCloseTo(1, 12)
    // up is local north
    const ll = latLonOfDir(p.d)
    expect(ll.lat).toBeCloseTo(43.46, 9)
    expect(ll.lon).toBeCloseTo(-80.52, 9)
    expect(up.y).toBeGreaterThan(0.5)
  })

  it('tilts the camera back against its facing', () => {
    const p = makePose({ lat: 0, lon: 0, headingDeg: 0, range: 1, tilt: 35 * DEG })
    const pos = new Vector3()
    const up = new Vector3()
    const target = new Vector3()
    poseToCamera(p, pos, up, target)
    // facing north, so the camera sits south of the target (negative y), above the surface
    expect(pos.y).toBeLessThan(0)
    expect(pos.x).toBeGreaterThan(1)
    const view = target.clone().sub(pos).normalize()
    expect(Math.abs(view.dot(up))).toBeLessThan(1e-12) // up ⟂ view direction
  })

  it('round-trips heading', () => {
    for (const h of [-170, -90, 0, 35, 90, 179]) {
      const p = makePose({ lat: 51, lon: 12, headingDeg: h, range: 1 })
      expect(headingOf(p.d, p.fwd) / DEG).toBeCloseTo(h, 9)
    }
  })
})

describe('interpolatePose', () => {
  const a = makePose({ lat: 43.46, lon: -80.52, range: 0.5, headingDeg: 0, tilt: 0.2 })
  const b = makePose({ lat: 35.68, lon: 139.69, range: 0.5, headingDeg: 20, tilt: 0.6 })

  it('hits both endpoints exactly', () => {
    const plan = planFlight(a, b)
    const o = createPose()
    interpolatePose(a, b, 0, plan.bump, o)
    expect(near(o.d, a.d, 1e-9)).toBe(true)
    expect(near(o.fwd, a.fwd, 1e-9)).toBe(true)
    expect(o.range).toBeCloseTo(a.range, 12)
    interpolatePose(a, b, 1, plan.bump, o)
    expect(near(o.d, b.d, 1e-9)).toBe(true)
    expect(near(o.fwd, b.fwd, 1e-9)).toBe(true)
    expect(o.tilt).toBeCloseTo(b.tilt, 12)
  })

  it('follows the great circle and arcs up for a long hop between close views', () => {
    const plan = planFlight(a, b)
    expect(plan.bump).toBeGreaterThan(0.5)
    const o = createPose()
    interpolatePose(a, b, 0.5, plan.bump, o)
    expect(o.range).toBeGreaterThan(1.5)
    // midpoint lies on the great circle between a and b
    const n = a.d.clone().cross(b.d).normalize()
    expect(Math.abs(o.d.dot(n))).toBeLessThan(1e-9)
  })

  it('does not arc when zooming out to overview', () => {
    const ov = makePose({ lat: 20, lon: -60, range: 2.4 })
    const plan = planFlight(a, ov)
    expect(plan.bump).toBe(0)
    const o = createPose()
    let prev = a.range
    for (let i = 1; i <= 20; i++) {
      interpolatePose(a, ov, i / 20, plan.bump, o)
      expect(o.range).toBeGreaterThanOrEqual(prev - 1e-12) // monotonic, no overshoot
      prev = o.range
    }
  })

  it('never flips the camera when flying over a pole', () => {
    const p0 = makePose({ lat: 70, lon: 0, range: 0.6, headingDeg: 0 })
    const p1 = makePose({ lat: 70, lon: 180, range: 0.6, headingDeg: 180 })
    const plan = planFlight(p0, p1)
    const o = createPose()
    const pos = new Vector3()
    const up = new Vector3()
    const tgt = new Vector3()
    const prevUp = new Vector3()
    for (let i = 0; i <= 200; i++) {
      interpolatePose(p0, p1, i / 200, plan.bump, o)
      expect(Number.isFinite(o.fwd.x + o.fwd.y + o.fwd.z)).toBe(true)
      expect(Math.abs(o.fwd.dot(o.d))).toBeLessThan(1e-9)
      poseToCamera(o, pos, up, tgt)
      if (i > 0) expect(up.dot(prevUp)).toBeGreaterThan(0.95) // continuous orientation, no 180° snap
      prevUp.copy(up)
    }
  })

  it('handles antipodal hops', () => {
    const p0 = makePose({ lat: 0, lon: 0, range: 0.5 })
    const p1 = makePose({ lat: 0, lon: 180, range: 0.5 })
    const o = createPose()
    interpolatePose(p0, p1, 0.5, planFlight(p0, p1).bump, o)
    expect(Number.isFinite(o.d.x)).toBe(true)
    expect(o.d.length()).toBeCloseTo(1, 9)
  })

  it('plans durations inside the 2.4–3.6 s window', () => {
    const tiny = makePose({ lat: 43.47, lon: -80.5, range: 0.5 })
    expect(planFlight(a, tiny).duration).toBeGreaterThanOrEqual(FLIGHT_MIN_S)
    expect(planFlight(a, b).duration).toBeLessThanOrEqual(FLIGHT_MAX_S)
  })
})

describe('easing', () => {
  it('matches CSS cubic-bezier endpoints and symmetry of linear', () => {
    const lin = cubicBezier(0, 0, 1, 1)
    for (const x of [0, 0.1, 0.5, 0.9, 1]) expect(lin(x)).toBeCloseTo(x, 5)
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    let prev = 0
    for (let i = 1; i <= 100; i++) {
      const y = easeInOut(i / 100)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = y
    }
    // slow start, fast middle (ease-in-out .6,0,.2,1)
    expect(easeInOut(0.2)).toBeLessThan(0.1)
    expect(easeInOut(0.8)).toBeGreaterThan(0.9)
  })
})
