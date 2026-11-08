/**
 * GPU element buffer: the whole catalog as mean Keplerian elements with J2 secular drift, so the globe
 * can animate ~17k objects in a vertex shader.
 *
 * ═══════════════════════════ MATH (port this to GLSL verbatim) ═══════════════════════════
 *
 *  Inputs per satellite (stride 12 floats, see ElementBuffer):
 *    a      semi-major axis, world units (Earth radii of 6371 km)
 *    e      eccentricity
 *    i      inclination (rad)
 *    Ω0     right ascension of the ascending node at epoch (rad)
 *    ω0     argument of perigee at epoch (rad)
 *    M0     mean anomaly at epoch (rad)
 *    n      secular mean-anomaly rate (rad/s)
 *    Ω̇, ω̇   J2 (+J4) secular drift of node and perigee (rad/s)
 *    t_e    epochOffset: element-set epoch − refEpochMs (s)
 *
 *  Uniforms per frame (computed on the CPU in float64, then uploaded):
 *    uTime  = (simTime − refEpochMs) / 1000                 (s)
 *    uGmst  = gmst(simTime)  from src/lib/geo.ts            (rad)  →  pass cos/sin to save ALU
 *
 *  Per vertex:
 *    dt = uTime − t_e
 *    M  = mod(M0 + n·dt, 2π)            // wrap BEFORE any trig; use highp everywhere
 *    Ω  = Ω0 + Ω̇·dt
 *    ω  = ω0 + ω̇·dt
 *    E  = M + e·sin M                    // Kepler: E − e sin E = M, 4 Newton steps
 *    repeat 4:  E −= (E − e·sin E − M) / (1 − e·cos E)
 *    xp = a (cos E − e)                  // perifocal position
 *    yp = a √(1 − e²) sin E
 *    // perifocal → inertial (TEME): R3(−Ω) · R1(−i) · R3(−ω)
 *    cΩ, sΩ, cω, sω, ci, si = cos/sin of Ω, ω, i
 *    x = (cΩ cω − sΩ sω ci) xp + (−cΩ sω − sΩ cω ci) yp
 *    y = (sΩ cω + cΩ sω ci) xp + (−sΩ sω + cΩ cω ci) yp
 *    z = (sω si) xp           + (cω si) yp
 *    // inertial → Earth-fixed (rotate by −GMST), same as geo.ts eciToEcef
 *    xe =  cos(uGmst)·x + sin(uGmst)·y
 *    ye = −sin(uGmst)·x + cos(uGmst)·y
 *    ze =  z
 *    // Earth-fixed → three.js world, same as geo.ts ecefToWorld (units already Earth radii)
 *    world = vec3(xe, ze, −ye)
 *
 *  Precision: with refEpochMs = catalog fetchedAt and a ±7 day scrub, n·dt reaches ~700 rad; float32
 *  keeps that to ~4e-5 rad (≈ 0.3 km). Keep the shader in highp and wrap M as above.
 *
 *  Measured against full SGP4 at refEpoch ± 12 h / ± 24 h (elements.test.ts, real catalog):
 *    ISS 17.7 km, Sentinel-2A 16.5 km, NOAA-20 16.5 km, GOES-19 40.5 km (max over ±24 h);
 *    whole LEO catalog p50 16.5 km, p95 84 km; GEO p50 30 km, p95 43 km. 1–2 px at globe scale.
 *    The residual is SGP4's short-period J2 terms (a few km radial, ~10 km along-track) plus drag.
 *
 *  Where the elements come from: SGP4's own initialisation (satellite.js initl/sgp4init). The catalog's
 *  Kozai mean motion is converted to Brouwer mean motion n″ and semi-major axis a″ exactly as SGP4 does,
 *  and the secular rates Ṁ, Ω̇, ω̇ are SGP4's (J2 to second order + J4). Deep-space lunar-solar terms are
 *  omitted. Drag is quadratic in time and cannot be expressed in this layout, so objects with noticeable
 *  drag or thrust (|ṅ/2| above DRAG_ANCHOR_NDOT, ~60% of the catalog: everything low, decaying debris,
 *  Starlinks raising or lowering orbit) are re-anchored: their elements are SGP4's own mean elements AT
 *  refEpochMs (epochOffset = 0), with rates measured from SGP4 over ±1 orbit around that instant. That
 *  keeps them right near "now", where the globe lives. The shader math is identical either way.
 *  Cost: ~100–170 ms for the full catalog, paid once inside the elements worker (elements.worker.ts),
 *  never on the main thread in the app.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { constants, sgp4 } from 'satellite.js'
import { DEG, EARTH_RADIUS_KM, eciToEcef } from '@/lib/geo'
import type { CatalogRow } from '@/types'
import { CATEGORY_INDEX } from './categories'
import { forEachObject, prebuiltElements, ROW, rowEpochMs, type LoadedCatalog } from './catalog'
import { satrecFromRow } from './sgp4'
import { tsinceMin } from './propagate'

export const ELEMENT_STRIDE = 12
export const FLAG_FEATURED = 1

export interface ElementBuffer {
  count: number
  /** Shader time origin; pass uTime = (simTime − refEpochMs) / 1000 */
  refEpochMs: number
  /**
   * stride 12 floats per sat:
   * [0] a (world units, Earth radii)  [1] e  [2] i (rad)  [3] raan0 (rad)  [4] argp0 (rad)  [5] M0 (rad)
   * [6] n (rad/s)  [7] raanDot (rad/s, J2)  [8] argpDot (rad/s, J2)  [9] epochOffset (s, sat epoch − refEpoch)
   * [10] category index  [11] flags (bit0 = featured/interesting)
   */
  data: Float32Array
  norad: Int32Array
}

export interface MeanElements {
  aKm: number
  e: number
  i: number
  raan0: number
  argp0: number
  m0: number
  /** rad/s */
  mDot: number
  raanDot: number
  argpDot: number
  epochMs: number
}

const TWO_PI = 2 * Math.PI

/** SGP4-consistent mean elements and secular rates for one catalog row. */
export function meanElements(row: CatalogRow): MeanElements {
  const { xke, j2, j4, earthRadius, x2o3 } = constants
  const n0 = (row[ROW.meanMotion] * TWO_PI) / 1440 // Kozai mean motion, rad/min
  const e = row[ROW.ecc]
  const i = row[ROW.incl] * DEG
  const cosi = Math.cos(i)
  const cosi2 = cosi * cosi
  const omeosq = 1 - e * e
  const rteosq = Math.sqrt(omeosq)

  // Un-Kozai (SGP4 initl): Brouwer mean motion and semi-major axis.
  const ak = (xke / n0) ** x2o3
  const d1 = (0.75 * j2 * (3 * cosi2 - 1)) / (rteosq * omeosq)
  let del = d1 / (ak * ak)
  const adel = ak * (1 - del * del - del * (1 / 3 + (134 * del * del) / 81))
  del = d1 / (adel * adel)
  const no = n0 / (1 + del)
  const ao = (xke / no) ** x2o3 // Earth radii of 6378.135 km

  // Secular rates (SGP4 sgp4init).
  const po = ao * omeosq
  const pinvsq = 1 / (po * po)
  const cosi4 = cosi2 * cosi2
  const temp1 = 1.5 * j2 * pinvsq * no
  const temp2 = 0.5 * temp1 * j2 * pinvsq
  const temp3 = -0.46875 * j4 * pinvsq * pinvsq * no
  const mdot = no + 0.5 * temp1 * rteosq * (3 * cosi2 - 1) + 0.0625 * temp2 * rteosq * (13 - 78 * cosi2 + 137 * cosi4)
  const argpdot =
    -0.5 * temp1 * (1 - 5 * cosi2) + 0.0625 * temp2 * (7 - 114 * cosi2 + 395 * cosi4) + temp3 * (3 - 36 * cosi2 + 49 * cosi4)
  const nodedot = -temp1 * cosi + (0.5 * temp2 * (4 - 19 * cosi2) + 2 * temp3 * (3 - 7 * cosi2)) * cosi

  return {
    aKm: ao * earthRadius,
    e,
    i,
    raan0: row[ROW.raan] * DEG,
    argp0: row[ROW.argp] * DEG,
    m0: row[ROW.meanAnomaly] * DEG,
    mDot: mdot / 60,
    raanDot: nodedot / 60,
    argpDot: argpdot / 60,
    epochMs: rowEpochMs(row),
  }
}

/** |ṅ/2| (rev/day², the catalog's ndot column) above which an object is re-anchored at refEpochMs. */
export const DRAG_ANCHOR_NDOT = 5e-5

/**
 * SGP4's singly-averaged mean elements at `ms` (drag and deep-space secular effects included), with the
 * secular rates of M, Ω and ω measured by central difference over ±1 orbital period: SGP4's mean M and ω
 * carry an orbit-periodic drag term that cancels in M + ω, and differencing over a whole period cancels
 * it in each rate separately.
 */
export function anchoredElements(row: CatalogRow, base: MeanElements, ms: number): MeanElements | null {
  const satrec = satrecFromRow(row)
  if (!satrec) return null
  const at = (t: number) => sgp4(satrec, tsinceMin(satrec, t))?.meanElements
  const periodMs = (TWO_PI / base.mDot) * 1000
  const m0 = at(ms)
  const mA = at(ms - periodMs)
  const mB = at(ms + periodMs)
  if (!m0 || !mA || !mB) return null
  const span = (2 * periodMs) / 1000
  /** Rate from two angles 2 periods apart, unwrapped around the expected secular change. */
  const rate = (a: number, b: number, expected: number) => {
    const d = b - a - expected * span
    return expected + (d - TWO_PI * Math.round(d / TWO_PI)) / span
  }
  return {
    aKm: m0.am * constants.earthRadius,
    e: m0.em,
    i: m0.im,
    raan0: m0.Om,
    argp0: m0.om,
    m0: m0.mm,
    mDot: rate(mA.mm, mB.mm, base.mDot),
    raanDot: rate(mA.Om, mB.Om, base.raanDot),
    argpDot: rate(mA.om, mB.om, base.argpDot),
    epochMs: ms,
  }
}

/**
 * Pack the catalog for the GPU. refEpochMs = catalog fetchedAt.
 * A catalog loaded through the elements worker already has its buffer (built off the main thread): it is
 * returned as is, so the globe's call costs nothing.
 */
export function buildElementBuffer(cat: LoadedCatalog): ElementBuffer {
  const pre = prebuiltElements.get(cat)
  if (pre) return pre
  const refEpochMs = Date.parse(cat.fetchedAt)
  const n = cat.count
  const data = new Float32Array(n * ELEMENT_STRIDE)
  const norad = new Int32Array(n)
  let k = 0
  forEachObject(cat, (id, row, category) => {
    let m = meanElements(row)
    if (Math.abs(row[ROW.ndot]) > DRAG_ANCHOR_NDOT) m = anchoredElements(row, m, refEpochMs) ?? m
    if (!Number.isFinite(m.aKm) || !Number.isFinite(m.mDot)) return
    const o = k * ELEMENT_STRIDE
    data[o] = m.aKm / EARTH_RADIUS_KM
    data[o + 1] = m.e
    data[o + 2] = m.i
    data[o + 3] = m.raan0
    data[o + 4] = m.argp0
    data[o + 5] = m.m0
    data[o + 6] = m.mDot
    data[o + 7] = m.raanDot
    data[o + 8] = m.argpDot
    data[o + 9] = (m.epochMs - refEpochMs) / 1000
    data[o + 10] = CATEGORY_INDEX[category]
    data[o + 11] = category !== 'other' ? FLAG_FEATURED : 0
    norad[k] = id
    k++
  })
  return {
    count: k,
    refEpochMs,
    data: k === n ? data : data.slice(0, k * ELEMENT_STRIDE),
    norad: k === n ? norad : norad.slice(0, k),
  }
}

/** Inertial (TEME) position in world units, exactly as the shader computes it before the GMST rotation. */
export function keplerJ2Eci(buf: ElementBuffer, index: number, ms: number): [number, number, number] {
  const d = buf.data
  const o = index * ELEMENT_STRIDE
  const a = d[o]
  const e = d[o + 1]
  const inc = d[o + 2]
  const dt = (ms - buf.refEpochMs) / 1000 - d[o + 9]
  const M = (((d[o + 5] + d[o + 6] * dt) % TWO_PI) + TWO_PI) % TWO_PI
  const raan = d[o + 3] + d[o + 7] * dt
  const argp = d[o + 4] + d[o + 8] * dt
  let E = M + e * Math.sin(M)
  for (let k = 0; k < 4; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
  const xp = a * (Math.cos(E) - e)
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E)
  const cO = Math.cos(raan)
  const sO = Math.sin(raan)
  const cw = Math.cos(argp)
  const sw = Math.sin(argp)
  const ci = Math.cos(inc)
  const si = Math.sin(inc)
  return [
    (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp,
    (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp,
    sw * si * xp + cw * si * yp,
  ]
}

/**
 * Reference implementation of the shader: world-frame position (Earth radii) of satellite `index` at `ms`.
 * `out` may be a three.js Vector3 or any {x,y,z}.
 */
export function keplerJ2World<T extends { x: number; y: number; z: number }>(buf: ElementBuffer, index: number, ms: number, out: T): T {
  const [x, y, z] = keplerJ2Eci(buf, index, ms)
  const [xe, ye, ze] = eciToEcef(x, y, z, ms)
  out.x = xe
  out.y = ze
  out.z = -ye
  return out
}
