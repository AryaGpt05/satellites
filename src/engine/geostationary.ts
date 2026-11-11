/**
 * Geostationary weather imagers that see the place continuously.
 * Sub-satellite longitudes always come from propagating the current elements, never from a table.
 *
 * `rim` marks a watcher whose picture of the place is the edge of its disc. The map services draw each disc as seen
 * from the satellite's nominal seat on the equator and stop it short of the true horizon: an 800 km square around a
 * place starts losing data once that seat stands under 8–10° (measured 2026-11-11 on tracks north, north-east and
 * east of each sub-satellite point: GOES-East from 8°, Meteosat-12 from 7°, Meteosat-9 from 9°; whole everywhere at
 * 10°), and what is left is smeared six times over or more. Such a frame still shows in the watcher's row, small,
 * where it says truthfully how far out the place sits; it never leads the summary (results lib/bestLook.ts).
 * The seat on the equator matters: Meteosat-9 swings several degrees north and south of it each day, which lifts
 * its true elevation at a far-northern place without moving the edge of its picture.
 */
import { bearingDeg, DEG, EARTH_RADIUS_KM, haversineKm } from '@/lib/geo'
import type { GeoWatcher, LatLon, Pass, SatProfile, TrackPoint } from '@/types'
import { featuredSats, getSatInfo, type LoadedCatalog } from './catalog'
import { satrecFor } from './sgp4'
import { elevationDeg, offNadirDeg, sunElevationAtDeg } from './geometry'
import { stateAt } from './propagate'

/** A full-disk imager this low on the horizon still includes the place, but only at grazing view. */
export const GEO_MIN_ELEVATION_DEG = 5
/** From this elevation of the satellite's nominal seat, the frame's whole 800 km square lies on the disc as the services draw it. */
export const GEO_FRAME_MIN_ELEVATION_DEG = 10

/**
 * Operational weather-geo satellites standing ≥ 5° above the place's horizon, sorted by elevation.
 * `imagesInWindow` = full-disk images taken during the window that included the place.
 */
export function geoWatchers(cat: LoadedCatalog, place: LatLon, windowStart: number, windowEnd: number): GeoWatcher[] {
  const out: GeoWatcher[] = []
  // Only profiled satellites can be weather-geo imagers: the featured rows, never the whole catalog.
  for (const sat of featuredSats(cat)) {
    const p = sat.profile
    if (sat.category !== 'weather-geo' || !p?.operational || !p.cadenceMin) continue
    const satrec = satrecFor(sat.norad)
    const s = satrec && stateAt(satrec, windowEnd)
    if (!s) continue
    const el = elevationDeg(haversineKm(place, s), s.altKm)
    if (el < GEO_MIN_ELEVATION_DEG) continue
    const rim = elevationDeg(haversineKm(place, { lat: 0, lon: s.lon }), s.altKm) < GEO_FRAME_MIN_ELEVATION_DEG
    out.push({
      norad: sat.norad,
      name: sat.displayName,
      operator: p.operator,
      subLon: s.lon,
      elevationDeg: el,
      cadenceMin: p.cadenceMin,
      imagesInWindow: Math.floor((windowEnd - windowStart) / (p.cadenceMin * 60_000)),
      frames: p.frames,
      rim: rim || undefined,
    })
  }
  return out.sort((a, b) => b.elevationDeg - a.elevationDeg)
}

// ───────────────────────────── the scan that took a frame ─────────────────────────────

/**
 * How a full-disc scan moves over the ground, on the meridian under the satellite. The mirror steps evenly in scan
 * angle ε (± asin(1/r) from limb to limb, r the orbit's radius in Earth radii), so the line is at central angle
 * c = asin(r sin ε) − ε from the sub-satellite point: slowest under the satellite (18 km/s for a 10-minute disc),
 * racing near the limb.
 */
const centralAngle = (eps: number, r: number) => Math.asin(Math.max(-1, Math.min(1, r * Math.sin(eps)))) - eps
const scanAngle = (c: number, r: number) => Math.atan2(Math.sin(c), r - Math.cos(c))

/** Samples of the scan line's path (the track of a geostationary scan pass). */
const SCAN_SAMPLES = 72

/**
 * One full-disc scan as a pass: the scan that took the frame of `frameTime` (taken as the scan's start; the services
 * label frames by their slot, so the crossing below is good to about a minute, and the UI says "about").
 *
 * The satellite does not move, the scan line does. So the pass's track is the line's own path down (or up) the
 * meridian under the satellite, its heading and speed the line's, and its closest approach the moment the line (the
 * great circle across that meridian) crossed the place. Everything that replays a pass (the scan line on the globe,
 * the image developing behind it, the reveal in the panel) then shows what the imager did, with no second machinery.
 * Distance, elevation and azimuth are the real ones, to the satellite where it stood.
 * Undefined when the satellite has no scan pattern on file or its orbit cannot be propagated.
 */
export function geoScanPass(norad: number, place: LatLon, frameTime: number, captureId: string, profile: Pick<SatProfile, 'scan'> | undefined = getSatInfo(norad)?.profile): Pass | undefined {
  const scan = profile?.scan
  const satrec = satrecFor(norad)
  const at = satrec && stateAt(satrec, frameTime)
  if (!scan || !at) return undefined
  const r = 1 + at.altKm / EARTH_RADIUS_KM
  const epsMax = Math.asin(1 / r)
  const durMs = scan.minutes * 60_000
  const dir = scan.from === 'north' ? -1 : 1 // the sign of dε/dt, north positive
  // Where the line's path (the meridian under the satellite) is nearest the place, as a central angle from the
  // sub-satellite point, north positive.
  const dLon = (((place.lon - at.lon + 540) % 360) - 180) * DEG
  const cPlace = Math.atan2(Math.tan(place.lat * DEG), Math.cos(dLon)) - at.lat * DEG
  const cMax = Math.acos(1 / r)
  const epsPlace = scanAngle(Math.max(-cMax, Math.min(cMax, cPlace)), r)
  const u = (dir * epsPlace + epsMax) / (2 * epsMax)
  const tClosest = Math.round(frameTime + u * durMs)
  const epsRate = (2 * epsMax) / (durMs / 1000) // rad / s
  const dcde = (r * Math.cos(epsPlace)) / Math.sqrt(Math.max(1e-6, 1 - (r * Math.sin(epsPlace)) ** 2)) - 1
  const track: TrackPoint[] = []
  for (let i = 0; i <= SCAN_SAMPLES; i++) {
    // Short of the limbs themselves, where the line's speed has no bound.
    const f = 0.01 + (0.98 * i) / SCAN_SAMPLES
    const eps = -dir * epsMax + dir * f * 2 * epsMax
    track.push({ t: Math.round(frameTime + f * durMs), lat: at.lat + centralAngle(eps, r) / DEG, lon: at.lon, altKm: at.altKm })
  }
  const d = haversineKm(place, at)
  return {
    id: `geo-${norad}-${Math.round(frameTime / 60_000)}`,
    norad,
    tClosest,
    tStart: frameTime,
    tEnd: frameTime + durMs,
    groundDistanceKm: d,
    offNadirDeg: offNadirDeg(d, at.altKm),
    elevationDeg: elevationDeg(d, at.altKm),
    azimuthDeg: bearingDeg(place, at),
    altitudeKm: at.altKm,
    groundSpeedKmS: Math.min(400, dcde * epsRate * EARTH_RADIUS_KM),
    headingDeg: dir < 0 ? 180 : 0,
    node: dir < 0 ? 'descending' : 'ascending',
    sunElevationDeg: sunElevationAtDeg(place.lat, place.lon, tClosest),
    inSwath: true,
    inFieldOfRegard: true,
    verdict: 'imaged',
    track,
    captureId,
    geostationary: true,
  }
}
