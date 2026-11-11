/**
 * Geostationary weather imagers that see the place continuously.
 * Sub-satellite longitudes always come from propagating the current elements, never from a table.
 *
 * A watcher's public frame (src/imagery/geoFrames.ts) is only offered where the picture is worth showing. The map
 * services draw each disc as seen from the satellite's nominal seat on the equator and stop it about 5° of
 * elevation short of the true horizon (measured 2026-11-11: GOES-East and -West end at 4.8°, Meteosat-12 at 3.9°,
 * Meteosat-9 at 4.3–6.0°). An 800 km square around a place nearer the rim than that is part empty and smeared
 * several times over, so under `GEO_FRAME_MIN_ELEVATION_DEG` the watcher is listed without a frame (`rim`).
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
export const GEO_FRAME_MIN_ELEVATION_DEG = 12

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
    const onDisc = !!p.frames && elevationDeg(haversineKm(place, { lat: 0, lon: s.lon }), s.altKm) >= GEO_FRAME_MIN_ELEVATION_DEG
    out.push({
      norad: sat.norad,
      name: sat.displayName,
      operator: p.operator,
      subLon: s.lon,
      elevationDeg: el,
      cadenceMin: p.cadenceMin,
      imagesInWindow: Math.floor((windowEnd - windowStart) / (p.cadenceMin * 60_000)),
      frames: onDisc ? p.frames : undefined,
      rim: p.frames && !onDisc ? true : undefined,
    })
  }
  return out.sort((a, b) => b.elevationDeg - a.elevationDeg)
}
