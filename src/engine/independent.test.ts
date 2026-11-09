/**
 * Independent cross-check of the pass search (reviewer's test).
 *
 * The reference below shares NO geometry with the engine: it uses satellite.js directly (OMM →
 * satrec, `propagate`, `gstime`, `eciToEcf`, `eciToGeodetic`, `ecfToLookAngles`, `sunPos`) and its own
 * 3D vector maths on the WGS-84 ellipsoid, sampled every second over 2 days (7 for Sentinel-2C). The engine uses a
 * spherical-Earth model (haversine on R = 6371 km) plus a provably complete coarse search; the two must
 * agree on every pass that is not within a hair of a threshold.
 *
 * Criteria (docs/ARCHITECTURE.md verdict rules):
 *  - Sentinel-2C  'likely'   : sub-satellite point within 145 km (290 km swath / 2), sun ≥ 5°
 *  - ISS          'overhead' : true topocentric elevation ≥ 10°
 *  - WorldView-3  'could'    : true off-nadir angle ≤ 40°, sun ≥ 5°
 *  - NOAA-20      'likely'   : within 1,520 km of the ground track (3,040 km swath), any light
 */
import {
  degreesToRadians,
  eciToEcf,
  eciToGeodetic,
  ecfToLookAngles,
  geodeticToEcf,
  gstime,
  json2satrec,
  propagate,
  sunPos,
  type SatRec,
} from 'satellite.js'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CatalogFile, CatalogRow, LatLon, Pass } from '@/types'
import { getRow, getSatInfo } from './catalog'
import { findPassesForSat, passTargetFor } from './passes'
import { catalogFile, loadTestCatalog, WATERLOO } from './testing'
import { satrecFor } from './sgp4'

const DAY = 86_400_000
const R_SPHERE = 6371

let file: CatalogFile
let tEnd: number
beforeAll(() => {
  loadTestCatalog()
  file = catalogFile()
  tEnd = Date.parse(file.fetchedAt)
})

function referenceSatrec(norad: number): SatRec {
  const r = file.rows.find((x) => x[0] === norad) as CatalogRow
  return json2satrec({
    OBJECT_NAME: r[1],
    OBJECT_ID: r[2],
    EPOCH: r[3],
    MEAN_MOTION: r[4],
    ECCENTRICITY: r[5],
    INCLINATION: r[6],
    RA_OF_ASC_NODE: r[7],
    ARG_OF_PERICENTER: r[8],
    MEAN_ANOMALY: r[9],
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: r[0],
    ELEMENT_SET_NO: 999,
    BSTAR: r[10],
    MEAN_MOTION_DOT: r[11],
    MEAN_MOTION_DDOT: r[12],
  })
}

type V3 = { x: number; y: number; z: number }
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z
const norm = (a: V3) => Math.sqrt(dot(a, a))
const angleDeg = (a: V3, b: V3) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (norm(a) * norm(b))))) * 180) / Math.PI

/** Great-circle distance on the R = 6371 sphere between two geodetic points (radians). */
function gcKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const c = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1)
  return Math.acos(Math.max(-1, Math.min(1, c))) * R_SPHERE
}

interface Sample {
  t: number
  groundKm: number
  elevationDeg: number
  offNadirDeg: number
  sunDeg: number
}

/** One sample of the independent geometry at `ms`. */
function sampleAt(satrec: SatRec, place: LatLon, ms: number): Sample | null {
  const date = new Date(ms)
  const pv = propagate(satrec, date)
  if (!pv) return null
  const g = gstime(date)
  const ecf = eciToEcf(pv.position, g)
  const geo = eciToGeodetic(pv.position, g)
  const obs = { latitude: degreesToRadians(place.lat), longitude: degreesToRadians(place.lon), height: 0 }
  const obsEcf = geodeticToEcf(obs)
  const look = ecfToLookAngles(obs, ecf)
  // True off-nadir: angle at the satellite between the direction to Earth's centre and the place.
  // A place below the horizon also makes a small angle with nadir (the line of sight crosses the Earth),
  // so it only counts while the satellite is above the place's horizon.
  const offNadirDeg = look.elevation > 0 ? angleDeg({ x: -ecf.x, y: -ecf.y, z: -ecf.z }, sub(obsEcf, ecf)) : 180
  // Sun elevation from satellite.js sunPos (independent of geo.ts), against the geodetic vertical.
  const jd = ms / DAY + 2440587.5
  const s = sunPos(jd).rsun
  const sunEcf = eciToEcf({ x: s.x, y: s.y, z: s.z }, g)
  const up: V3 = { x: Math.cos(obs.latitude) * Math.cos(obs.longitude), y: Math.cos(obs.latitude) * Math.sin(obs.longitude), z: Math.sin(obs.latitude) }
  const sunDeg = 90 - angleDeg(up, sunEcf)
  return {
    t: ms,
    groundKm: gcKm(obs.latitude, obs.longitude, geo.latitude, geo.longitude),
    elevationDeg: (look.elevation * 180) / Math.PI,
    offNadirDeg,
    sunDeg,
  }
}

interface RefEvent {
  t: number
  /** Value of the deciding quantity at the event (km or degrees) */
  value: number
  sunDeg: number
}

/** Local optima (min of `key`, or max when `max`) over [t0, t1] at 1 s. */
function referenceEvents(satrec: SatRec, place: LatLon, t0: number, t1: number, key: keyof Sample, max = false): RefEvent[] {
  const out: RefEvent[] = []
  const sign = max ? -1 : 1
  let a: Sample | null = null
  let b: Sample | null = null
  for (let t = t0 - 60_000; t <= t1 + 60_000; t += 1000) {
    const c = sampleAt(satrec, place, t)
    if (a && b && c) {
      const va = sign * a[key]
      const vb = sign * b[key]
      const vc = sign * c[key]
      if (vb < va && vb <= vc && b.t >= t0 && b.t <= t1) out.push({ t: b.t, value: b[key], sunDeg: b.sunDeg })
    }
    a = b
    b = c
  }
  return out
}

function enginePasses(norad: number, place: LatLon, t0: number, t1: number): Pass[] {
  const target = passTargetFor(getSatInfo(norad)!, getRow(norad)!)!
  return findPassesForSat(satrecFor(norad)!, target, { place, t0, t1 })
}

interface Case {
  name: string
  norad: number
  key: keyof Sample
  max?: boolean
  /** Reference predicate on the event value */
  inside: (v: number) => boolean
  /** |value − threshold| below which spherical vs ellipsoidal models may legitimately disagree */
  borderline: (v: number) => boolean
  daylight: boolean
  /** Max allowed |Δt| between engine tClosest and the reference optimum, ms */
  dtMs: number
  /** Window length (days, ending at the catalog epoch). Sentinel-2C repeats every 10 days, so it needs 7. */
  days: number
}

const CASES: Case[] = [
  {
    name: 'Sentinel-2C over Waterloo, 7 days (swath 290 km, sun ≥ 5°)',
    norad: 60989,
    key: 'groundKm',
    inside: (v) => v <= 145,
    borderline: (v) => Math.abs(v - 145) < 1.5,
    daylight: true,
    dtMs: 2000,
    days: 7,
  },
  {
    name: 'ISS over Waterloo, 2 days (true elevation ≥ 10°)',
    norad: 25544,
    key: 'elevationDeg',
    max: true,
    inside: (v) => v >= 10,
    borderline: (v) => Math.abs(v - 10) < 0.35,
    daylight: false,
    // Max elevation and min ground distance are not the same instant for a curved track: allow 10 s.
    dtMs: 10_000,
    days: 2,
  },
  {
    name: 'WorldView-3 over Waterloo, 4 days (true off-nadir ≤ 40°, sun ≥ 5°)',
    norad: 40115,
    key: 'offNadirDeg',
    inside: (v) => v <= 40,
    borderline: (v) => Math.abs(v - 40) < 0.35,
    daylight: true,
    dtMs: 10_000,
    days: 4,
  },
  {
    name: 'NOAA-20 over Waterloo, 2 days (swath 3,040 km)',
    norad: 43013,
    key: 'groundKm',
    inside: (v) => v <= 1520,
    borderline: (v) => Math.abs(v - 1520) < 3,
    daylight: false,
    dtMs: 2000,
    days: 2,
  },
]

describe('independent brute force (satellite.js + WGS-84 vectors, 1 s)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const t0 = tEnd - c.days * DAY
      const ref = referenceEvents(referenceSatrec(c.norad), WATERLOO, t0, tEnd, c.key, c.max)
      const engine = enginePasses(c.norad, WATERLOO, t0, tEnd)
      const qualifies = (e: RefEvent) => c.inside(e.value) && (!c.daylight || e.sunDeg >= 5)
      const sunBorder = (e: RefEvent) => c.daylight && Math.abs(e.sunDeg - 5) < 0.2
      const must = ref.filter((e) => qualifies(e) && !c.borderline(e.value) && !sunBorder(e))
      const may = ref.filter((e) => c.borderline(e.value) || sunBorder(e))
      const nearest = (t: number) => engine.reduce((best, p) => (Math.abs(p.tClosest - t) < Math.abs(best - t) ? p.tClosest : best), Number.POSITIVE_INFINITY)

      // Every pass the reference requires is found, at the right time.
      const missed = must.filter((e) => Math.abs(nearest(e.t) - e.t) > c.dtMs)
      // Every engine pass corresponds to a reference event that qualifies (or is borderline).
      const allowed = [...must, ...may]
      const spurious = engine.filter((p) => !allowed.some((e) => Math.abs(e.t - p.tClosest) <= c.dtMs))
      const worstDt = must.reduce((m, e) => Math.max(m, Math.abs(nearest(e.t) - e.t)), 0)
      console.log(
        `${c.name}: reference ${must.length} (+${may.length} borderline), engine ${engine.length}, ` +
          `worst |Δt| ${(worstDt / 1000).toFixed(2)} s, missed ${missed.length}, spurious ${spurious.length}`,
      )
      expect(missed.map((e) => new Date(e.t).toISOString())).toEqual([])
      expect(spurious.map((p) => new Date(p.tClosest).toISOString())).toEqual([])
      expect(must.length).toBeGreaterThan(0)

      // The engine's spherical geometry agrees with the true 3D geometry at closest approach.
      for (const p of engine) {
        const s = sampleAt(referenceSatrec(c.norad), WATERLOO, p.tClosest)!
        expect(Math.abs(p.sunElevationDeg - s.sunDeg)).toBeLessThan(0.1)
        expect(Math.abs(p.groundDistanceKm - s.groundKm)).toBeLessThan(0.5)
        expect(Math.abs(p.elevationDeg - s.elevationDeg)).toBeLessThan(0.4)
        expect(Math.abs(p.offNadirDeg - s.offNadirDeg)).toBeLessThan(0.4)
      }
    })
  }
})
