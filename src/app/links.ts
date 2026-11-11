/**
 * What the address bar asks for, and which pass a report opens on. Pure functions (no store, no DOM), so the
 * link rules are unit-tested (src/app/app.test.ts).
 *
 *   /?s=<shareId>                                       a shared pass (resolved by the controller)
 *   /?q=<lat>,<lon>&n=<label>[&p=<passId>]              a deep link straight to a report
 *   /?q=…&p=…&norad=<id>&t=<ms>[&sat=…&verdict=…]       share's fallback deep link (R2K5): opens that satellite's
 *                                                       pass nearest t, with the window re-centred on t when
 *                                                       t is older than the default window
 */
import type { Place, Report } from '@/types'

const DAY = 86_400_000

export interface RunOpts {
  now?: number
  selectPassId?: string
  selectNorad?: number
  selectNear?: number
  /** A shared geostationary image: the report holds that very frame (engine ReportOptions.geoItem) */
  geoItem?: { norad: number; collection: string; itemId: string }
}

/**
 * The geostationary image a share carries, if it is one: a recipient's report would otherwise hold that watcher's
 * NEWEST frame, not the one that was shared.
 */
export function sharedGeoItem(share: { norad?: number; capture?: { collection: string; itemId: string } }): RunOpts['geoItem'] {
  const c = share.capture
  if (!c || share.norad === undefined || !/^(gibs-(goes-east|goes-west|himawari)|eumetsat-meteosat-)/.test(c.collection)) return undefined
  return { norad: share.norad, collection: c.collection, itemId: c.itemId }
}

export type UrlTarget = { kind: 'share'; id: string } | { kind: 'q'; place: Place; opts: RunOpts }

/**
 * The report options that open `norad`'s pass nearest `t`: the window ends now, or, when t is older than six
 * days (it would sit at or past the window's start), is centred on t. Shared by /s/ links and fallback links.
 */
export function passLinkOpts(t: number, norad: number | undefined, now: number = Date.now()): RunOpts {
  return { now: now - t > 6 * DAY ? t + 3.5 * DAY : now, selectNorad: norad, selectNear: t }
}

/** A positive integer from a query value, else undefined ("", "1.5", "-3", "1e3x" are all invalid). */
function positiveInt(v: string | null): number | undefined {
  if (v === null || !/^\d+$/.test(v.trim())) return undefined
  const n = Number(v)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** What `search` (location.search) asks for; null for the landing. */
export function readUrlTarget(search: string, now: number = Date.now()): UrlTarget | null {
  const params = new URLSearchParams(search)
  if (params.has('sandbox')) return null
  const shareId = params.get('s')
  if (shareId) return { kind: 'share', id: shareId }
  const q = params.get('q')
  if (!q) return null
  const [lat, lon] = q.split(',').map(Number)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const label = params.get('n') || `${lat.toFixed(3)}, ${lon.toFixed(3)}`
  const place: Place = { label, lat, lon, source: 'url' }
  // A fallback share link carries its pass (norad + closest-approach time): the pass id alone may not match
  // in a window computed later or for the rounded spot. The other pass keys (sat, verdict, …) are for unfurls.
  const t = positiveInt(params.get('t'))
  const norad = positiveInt(params.get('norad'))
  if (t !== undefined && norad !== undefined) return { kind: 'q', place, opts: passLinkOpts(t, norad, now) }
  return { kind: 'q', place, opts: { selectPassId: params.get('p') ?? undefined } }
}

/** The pass a report opens on: the named pass if it is in the report, else `selectNorad`'s pass nearest `selectNear`. */
export function pickPreselect(report: Pick<Report, 'passes' | 'windowEnd'>, opts: RunOpts): string | undefined {
  if (opts.selectPassId && report.passes.some((p) => p.id === opts.selectPassId)) return opts.selectPassId
  if (opts.selectNorad !== undefined) {
    const near = opts.selectNear ?? report.windowEnd
    let best: { id: string; d: number } | undefined
    for (const p of report.passes) {
      if (p.norad !== opts.selectNorad) continue
      const d = Math.abs(p.tClosest - near)
      if (!best || d < best.d) best = { id: p.id, d }
    }
    if (best) return best.id
  }
  return undefined
}
