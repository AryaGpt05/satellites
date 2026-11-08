/**
 * Geostationary weather imagers that see the place continuously.
 * Sub-satellite longitudes always come from propagating the current elements, never from a table.
 */
import { haversineKm } from '@/lib/geo'
import type { GeoWatcher, LatLon } from '@/types'
import { satrecFor, type LoadedCatalog } from './catalog'
import { elevationDeg } from './geometry'
import { stateAt } from './propagate'

/** A full-disk imager this low on the horizon still includes the place, but only at grazing view. */
export const GEO_MIN_ELEVATION_DEG = 5

/**
 * Operational weather-geo satellites standing ≥ 5° above the place's horizon, sorted by elevation.
 * `imagesInWindow` = full-disk images taken during the window that included the place.
 */
export function geoWatchers(cat: LoadedCatalog, place: LatLon, windowStart: number, windowEnd: number): GeoWatcher[] {
  const out: GeoWatcher[] = []
  for (const sat of cat.sats) {
    const p = sat.profile
    if (sat.category !== 'weather-geo' || !p?.operational || !p.cadenceMin) continue
    const satrec = satrecFor(sat.norad)
    const s = satrec && stateAt(satrec, windowEnd)
    if (!s) continue
    const el = elevationDeg(haversineKm(place, s), s.altKm)
    if (el < GEO_MIN_ELEVATION_DEG) continue
    out.push({
      norad: sat.norad,
      name: sat.displayName,
      operator: p.operator,
      subLon: s.lon,
      elevationDeg: el,
      cadenceMin: p.cadenceMin,
      imagesInWindow: Math.floor((windowEnd - windowStart) / (p.cadenceMin * 60_000)),
      gibs: p.gibs ? { collection: p.gibs.collection, layer: p.gibs.layer } : undefined,
    })
  }
  return out.sort((a, b) => b.elevationDeg - a.elevationDeg)
}
