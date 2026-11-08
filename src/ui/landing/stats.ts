/**
 * Live usage stats for the landing footnote, from the backend module's `getStats()`
 * (contract: `getStats(): Promise<{ total: number; last24h: number } | null>`, no-op → null when the
 * database isn't configured).
 *
 * Loaded lazily through import.meta.glob: the Supabase client stays out of the first paint, and the
 * landing keeps building if src/lib/backend.ts isn't there (the glob is simply empty). Anything
 * missing, slow, malformed or zero renders nothing — never a placeholder number.
 */
import { useEffect, useState } from 'react'

export interface LookupStats {
  total: number
  last24h: number
}

interface BackendModule {
  getStats?: () => Promise<LookupStats | null>
}

const loaders = import.meta.glob<BackendModule>('../../lib/backend.ts')
const loadBackend = Object.values(loaders)[0]

/** Give up quietly after this; the line is a nicety. */
const STATS_TIMEOUT_MS = 6000

export function validStats(v: unknown): v is LookupStats {
  if (!v || typeof v !== 'object') return false
  const { total, last24h } = v as Record<string, unknown>
  return (
    typeof total === 'number' &&
    typeof last24h === 'number' &&
    Number.isFinite(total) &&
    Number.isFinite(last24h) &&
    total > 0 &&
    last24h >= 0 &&
    last24h <= total
  )
}

export function useLookupStats(): LookupStats | null {
  const [stats, setStats] = useState<LookupStats | null>(null)
  useEffect(() => {
    if (!loadBackend) return
    let alive = true
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), STATS_TIMEOUT_MS))
    Promise.race([loadBackend().then((m) => (m.getStats ? m.getStats() : null)), timeout])
      .then((v) => {
        if (alive && validStats(v)) setStats({ total: v.total, last24h: v.last24h })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return stats
}
