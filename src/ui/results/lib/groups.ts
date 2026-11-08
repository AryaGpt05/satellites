/**
 * Pass list model. A real week over a city is ~1,900 passes from ~250 satellites, so the list is:
 *
 *   PHOTOGRAPHED   each detailed image as its own row (they are the point), weather mosaics
 *                  summarised per satellite ("NOAA-20 · 7 images")
 *   LIKELY / COULD / OVERHEAD
 *                  one row per satellite (count, latest, closest), expandable to its passes
 *
 * Each group shows its top rows and a "show all"; the UI pages long groups.
 */
import type { Pass, Report } from '@/types'
import { isDailyMosaic } from './captures'
import { VERDICTS, type MetaFn, type SatMeta, type Verdict } from './meta'

export interface PassItem {
  kind: 'pass'
  key: string
  pass: Pass
  meta: SatMeta
}

export interface SatItem {
  kind: 'sat'
  key: string
  meta: SatMeta
  /** newest first */
  passes: Pass[]
  latest: Pass
  /** smallest off-nadir angle among its passes */
  closest: Pass
}

export type ListItem = PassItem | SatItem

export interface PassGroup {
  verdict: Verdict
  passCount: number
  satCount: number
  items: ListItem[]
}

export function groupPasses(report: Pick<Report, 'passes' | 'captures'>, meta: MetaFn): PassGroup[] {
  const captureById = new Map(report.captures.map((c) => [c.id, c]))
  const groups: PassGroup[] = []
  for (const verdict of VERDICTS) {
    const passes = report.passes.filter((p) => p.verdict === verdict).sort((a, b) => b.tClosest - a.tClosest)
    if (!passes.length) continue
    const singles: PassItem[] = []
    const bySat = new Map<number, Pass[]>()
    for (const p of passes) {
      const c = p.captureId ? captureById.get(p.captureId) : undefined
      if (verdict === 'imaged' && !(c && isDailyMosaic(c))) {
        singles.push({ kind: 'pass', key: `p:${p.id}`, pass: p, meta: meta(p.norad) })
        continue
      }
      const list = bySat.get(p.norad)
      if (list) list.push(p)
      else bySat.set(p.norad, [p])
    }
    const sats: SatItem[] = [...bySat.entries()].map(([norad, ps]) => ({
      kind: 'sat',
      key: `s:${verdict}:${norad}`,
      meta: meta(norad),
      passes: ps,
      latest: ps[0],
      closest: ps.reduce((a, b) => (b.offNadirDeg < a.offNadirDeg ? b : a)),
    }))
    // Most passes first (the satellites that watch this place most), then the most recent.
    sats.sort((a, b) => b.passes.length - a.passes.length || b.latest.tClosest - a.latest.tClosest || a.meta.name.localeCompare(b.meta.name))
    groups.push({
      verdict,
      passCount: passes.length,
      satCount: new Set(passes.map((p) => p.norad)).size,
      items: [...singles, ...sats],
    })
  }
  return groups
}

/** Rows shown before "show all", per group. */
export const GROUP_CAP: Record<Verdict, number> = { imaged: 12, likely: 6, could: 6, overhead: 6 }
/** Rows added per "show more" press once expanded (keeps the DOM small for 236-satellite groups). */
export const GROUP_PAGE = 40

/** How many rows to render for a group given how far it has been expanded (0 = collapsed). */
export function visibleCount(total: number, verdict: Verdict, pages: number): number {
  if (pages <= 0) return Math.min(total, GROUP_CAP[verdict])
  return Math.min(total, GROUP_CAP[verdict] + pages * GROUP_PAGE)
}
