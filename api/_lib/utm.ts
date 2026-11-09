/**
 * Universal Transverse Mercator on WGS 84 (EPSG:326zz north, 327zz south), forward and inverse: Krüger's series to
 * fourth order in the third flattening n (Karney 2011, "Transverse Mercator with an accuracy of a few nanometers",
 * eqs. 35–36), with the conformal latitude solved by Newton's method (Karney's tauf). The truncation error is
 * under 0.1 mm anywhere within 4000 km of the central meridian, i.e. every place a UTM scene covers.
 *
 * Planetary Computer serves Sentinel-2 and Landsat on these grids; crops requested on the item's own grid at whole
 * native pixels are copied 1:1 with no resampling (./toneRender.ts nativeBox). Self-contained (no imports): the
 * browser bundle and the functions share it.
 */

const A_WGS84 = 6378137
const F_WGS84 = 1 / 298.257223563
const K0 = 0.9996
const FALSE_EASTING = 500_000
const FALSE_NORTHING_SOUTH = 10_000_000
const DEG = Math.PI / 180

const n = F_WGS84 / (2 - F_WGS84)
const n2 = n * n
const n3 = n2 * n
const n4 = n3 * n
const E = Math.sqrt(F_WGS84 * (2 - F_WGS84))
const E2M = 1 - E * E
/** Rectifying radius A, times k0. */
const K0A = (K0 * A_WGS84 * (1 + n2 / 4 + n4 / 64)) / (1 + n)
const ALPHA = [
  n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180,
  (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440,
  (61 * n3) / 240 - (103 * n4) / 140,
  (49561 * n4) / 161280,
]
const BETA = [
  n / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360,
  n2 / 48 + n3 / 15 - (437 * n4) / 1440,
  (17 * n3) / 480 - (37 * n4) / 840,
  (4397 * n4) / 161280,
]

export interface UtmZone {
  zone: number
  south: boolean
}

/** The zone of an EPSG code: 32601–32660 (north), 32701–32760 (south); null for any other CRS. */
export function utmZoneOf(epsg: number): UtmZone | null {
  if (!Number.isInteger(epsg)) return null
  if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, south: false }
  if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, south: true }
  return null
}

export const isUtmEpsg = (epsg: number) => utmZoneOf(epsg) !== null

/** Central meridian of a zone, degrees. */
export const centralMeridianDeg = (zone: number) => zone * 6 - 183

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180

/**
 * The UTM zone (1–60) a place belongs to, as MGRS and the Sentinel-2 tiling grid draw them: 6° of longitude each,
 * with the two exceptions, south-west Norway (56°–64° N, 3°–12° E: zone 32) and Svalbard (72°–84° N: zones 31, 33,
 * 35, 37 only). Null outside UTM's latitudes (80° S to 84° N: the poles are UPS).
 */
export function utmZoneAt(lat: number, lon: number): number | null {
  if (!(lat >= -80 && lat < 84) || !Number.isFinite(lon)) return null
  const l = wrap180(lon)
  if (lat >= 56 && lat < 64 && l >= 3 && l < 12) return 32
  if (lat >= 72 && l >= 0 && l < 42) return l < 9 ? 31 : l < 21 ? 33 : l < 33 ? 35 : 37
  return Math.min(60, Math.floor((l + 180) / 6) + 1)
}

/** τ′ (tangent of the conformal latitude) from τ (tangent of the geodetic latitude). */
function taupf(tau: number): number {
  const tau1 = Math.hypot(1, tau)
  const sig = Math.sinh(E * Math.atanh((E * tau) / tau1))
  return Math.hypot(1, sig) * tau - sig * tau1
}

/** τ from τ′ (Newton; converges in 2–3 steps). */
function tauf(taup: number): number {
  let tau = taup / E2M
  for (let i = 0; i < 8; i++) {
    const taupa = taupf(tau)
    const dtau = ((taup - taupa) * (1 + E2M * tau * tau)) / (E2M * Math.hypot(1, tau) * Math.hypot(1, taupa))
    tau += dtau
    if (Math.abs(dtau) < 1e-14 * Math.max(1, Math.abs(tau))) break
  }
  return tau
}

function zoneOrThrow(epsg: number): UtmZone {
  const z = utmZoneOf(epsg)
  if (!z) throw new Error(`not a UTM EPSG code: ${epsg}`)
  return z
}

/** [easting, northing] in metres of a WGS 84 lat/lon (degrees) on `epsg`'s grid. Any latitude: EPSG:326zz south of the equator gives negative northings (as Landsat's products use). */
export function utmForward(epsg: number, lat: number, lon: number): [number, number] {
  const { zone, south } = zoneOrThrow(epsg)
  const phi = lat * DEG
  const lam = wrap180(lon - centralMeridianDeg(zone)) * DEG
  const taup = taupf(Math.tan(phi))
  const xip = Math.atan2(taup, Math.cos(lam))
  const etap = Math.asinh(Math.sin(lam) / Math.hypot(taup, Math.cos(lam)))
  let xi = xip
  let eta = etap
  for (let j = 1; j <= 4; j++) {
    const a = ALPHA[j - 1]
    xi += a * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap)
    eta += a * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap)
  }
  return [FALSE_EASTING + K0A * eta, (south ? FALSE_NORTHING_SOUTH : 0) + K0A * xi]
}

/** [lat, lon] in degrees of a point (metres) on `epsg`'s grid. */
export function utmInverse(epsg: number, x: number, y: number): [number, number] {
  const { zone, south } = zoneOrThrow(epsg)
  const xi = (y - (south ? FALSE_NORTHING_SOUTH : 0)) / K0A
  const eta = (x - FALSE_EASTING) / K0A
  let xip = xi
  let etap = eta
  for (let j = 1; j <= 4; j++) {
    const b = BETA[j - 1]
    xip -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
    etap -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
  }
  const s = Math.sinh(etap)
  const c = Math.cos(xip)
  const taup = Math.sin(xip) / Math.hypot(s, c)
  const lat = Math.atan(tauf(taup)) / DEG
  const lon = wrap180(centralMeridianDeg(zone) + Math.atan2(s, c) / DEG)
  return [lat, lon]
}

/**
 * Grid bearing of true north at a place, degrees clockwise from grid north (the meridian convergence with the sign
 * that turns a compass bearing into a grid bearing: grid = true + this). East of the central meridian in the north
 * true north leans west of grid north (negative); tan γ = tan(λ − λ0)·sin φ, so under 3° in a standard 6° zone, but up to
 * 5.4° in south-west Norway's zone 32 (3°–12° E around 9° E, to 64° N) and 6.0° in Svalbard's 12°-wide zones (to 84° N).
 */
export function gridBearingOfNorthDeg(epsg: number, lat: number, lon: number): number {
  const d = 1e-4 // ≈ 11 m
  const [x0, y0] = utmForward(epsg, lat - d / 2, lon)
  const [x1, y1] = utmForward(epsg, lat + d / 2, lon)
  return Math.atan2(x1 - x0, y1 - y0) / DEG
}

/** A compass bearing (degrees clockwise from true north) as a bearing on `epsg`'s grid (clockwise from grid north). */
export function gridBearingDeg(epsg: number, lat: number, lon: number, trueBearingDeg: number): number {
  return (((trueBearingDeg + gridBearingOfNorthDeg(epsg, lat, lon)) % 360) + 360) % 360
}

/** Point scale factor of the projection at a place (k0 = 0.9996 on the central meridian, ~1.0010 at a zone's edge). */
export function utmScaleFactor(epsg: number, lat: number, lon: number): number {
  const d = 1e-4
  const [x0, y0] = utmForward(epsg, lat - d / 2, lon)
  const [x1, y1] = utmForward(epsg, lat + d / 2, lon)
  // Ground length of d degrees of latitude on the ellipsoid (meridian radius of curvature).
  const phi = lat * DEG
  const e2 = E * E
  const M = (A_WGS84 * (1 - e2)) / Math.pow(1 - e2 * Math.sin(phi) ** 2, 1.5)
  return Math.hypot(x1 - x0, y1 - y0) / (M * d * DEG)
}
