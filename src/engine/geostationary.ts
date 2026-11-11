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
import { haversineKm } from '@/lib/geo'
import type { GeoWatcher, LatLon } from '@/types'
import { featuredSats, type LoadedCatalog } from './catalog'
import { satrecFor } from './sgp4'
import { elevationDeg } from './geometry'
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
