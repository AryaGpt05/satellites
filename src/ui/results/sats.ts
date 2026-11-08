/**
 * Runtime satellite metadata for the UI, resolved from the engine's loaded catalog + curated profiles.
 * Falls back to the profile table (by NORAD id) if the catalog is not loaded, and to "NORAD 12345"
 * if nothing is known. Results are cached once the catalog knows the satellite.
 */
import { getSatInfo, profileFor } from '@/engine'
import { fmtNorad } from '@/ui/system/format'
import type { SatMeta } from './lib/meta'

const cache = new Map<number, SatMeta>()

export function satMeta(norad: number): SatMeta {
  const hit = cache.get(norad)
  if (hit) return hit
  const info = getSatInfo(norad)
  const profile = info?.profile ?? profileFor(norad)
  const meta: SatMeta = {
    norad,
    name: info?.displayName ?? profile?.displayName ?? `NORAD ${fmtNorad(norad)}`,
    operator: profile?.operator,
    category: info?.category ?? profile?.category ?? 'other',
    profile,
  }
  if (info) cache.set(norad, meta)
  return meta
}
