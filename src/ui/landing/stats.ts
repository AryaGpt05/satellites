/**
 * Live usage stats for the landing footnote, from the backend's `getStats()`. That call never throws:
 * it resolves `null` when the database isn't configured, unreachable or slow. Anything missing,
 * malformed or too small to read as proof renders nothing — never a placeholder number, and never a
 * ghost-town "4 places checked" (PRD-14).
 */
import { useEffect, useState } from 'react'
import { getStats } from '@/lib/backend'

export interface LookupStats {
  total: number
  last24h: number
}

/** Below these the line stays hidden: small live counts read as an empty product. */
export const MIN_TOTAL = 1000
export const MIN_LAST_24H = 50

/** Give up quietly after this; the line is a nicety (the backend has its own, similar timeout). */
const STATS_TIMEOUT_MS = 6000

export function validStats(v: unknown): v is LookupStats {
  if (!v || typeof v !== 'object') return false
  const { total, last24h } = v as Record<string, unknown>
  return (
    typeof total === 'number' &&
    typeof last24h === 'number' &&
    Number.isFinite(total) &&
    Number.isFinite(last24h) &&
    total >= MIN_TOTAL &&
    last24h >= MIN_LAST_24H &&
    last24h <= total
  )
}

export function useLookupStats(): LookupStats | null {
  const [stats, setStats] = useState<LookupStats | null>(null)
  useEffect(() => {
    let alive = true
    let timer = 0
    const timeout = new Promise<null>((r) => (timer = window.setTimeout(() => r(null), STATS_TIMEOUT_MS)))
    Promise.race([getStats(), timeout])
      .then((v) => {
        if (alive && validStats(v)) setStats({ total: v.total, last24h: v.last24h })
      })
      .catch(() => undefined)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [])
  return stats
}
