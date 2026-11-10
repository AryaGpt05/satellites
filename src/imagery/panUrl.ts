/**
 * The lightbox's sharper layer for a Landsat 8/9 photo (photos.ts hiResUrl): its card, pan-sharpened with the same
 * capture's 15 m band (api/pan, imagery/panSharpen.ts). One string names it, so the shared loader (image.ts) caches
 * and dedupes it like any photo URL:
 *
 *   pansharp:<capture time, ms>|<the card's crop URL>|<the 30 m sharper layer, used if the pan can't be had>
 *
 * Planetary Computer's URLs are percent-encoded throughout, so '|' never occurs in them.
 */
import { panQuery } from '../../api/_lib/pan'
import { tonePlanForUrl } from '../../api/_lib/toneRender'

const PREFIX = 'pansharp:'

export const isPanSharpUrl = (url: string) => url.startsWith(PREFIX)

/** The pan-sharpened layer of `cardUrl` (captured at `t`), or undefined when its crop isn't one api/pan serves. */
export function panSharpUrl(cardUrl: string, t: number, fallbackUrl: string): string | undefined {
  return panApiPath(cardUrl, t) ? `${PREFIX}${Math.round(t)}|${cardUrl}|${fallbackUrl}` : undefined
}

export function parsePanSharpUrl(url: string): { t: number; cardUrl: string; fallbackUrl: string } | null {
  if (!isPanSharpUrl(url)) return null
  const [t, cardUrl, fallbackUrl] = url.slice(PREFIX.length).split('|')
  return Number.isFinite(Number(t)) && cardUrl && fallbackUrl ? { t: Number(t), cardUrl, fallbackUrl } : null
}

/** '/api/pan?…' for a Landsat card crop on its UTM grid at 1000 px (what api/_lib/pan.ts accepts), else null. */
export function panApiPath(cardUrl: string, t: number): string | null {
  const plan = tonePlanForUrl(cardUrl)
  if (!plan || plan.collection !== 'landsat-c2-l2' || plan.px !== 1000 || plan.crs === 4326) return null
  return `/api/pan?${panQuery(plan.box, plan.crs, t)}`
}
