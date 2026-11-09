/**
 * Share links and post text (pure).
 *
 * Privacy: a share never carries the exact searched point. Coordinates are rounded to 2 decimals
 * (≈ 1.1 km of latitude, less of longitude), and the card's crop is centred on that rounded point.
 */
import type { Pass } from '@/types'
import { cloudWords, photosSentence, summaryHeadline } from '../../../api/_lib/cardSpec'

/** 2 decimals of a degree ≈ 1.1 km north–south. */
export const SHARE_DECIMALS = 2

export function roundCoord(v: number, decimals = SHARE_DECIMALS): number {
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

export function roundedPlace(lat: number, lon: number): { lat: number; lon: number } {
  return { lat: roundCoord(lat), lon: roundCoord(lon) }
}

/**
 * The pass facts a fallback link carries (share R2SH2): the same ones a stored share holds, so a link
 * unfurler can print that pass's card (api/s → /api/og) without any database row.
 */
export interface DeepLinkPass {
  norad: number
  satName: string
  /** N, the satellites that watched the place that week: the card's "7 satellites watched Waterloo." */
  satellites?: number
  verdict: Pass['verdict']
  tClosest: number
  altitudeKm?: number
  offNadirDeg?: number
  headingDeg?: number
  capture?: {
    collection: string
    itemId: string
    cloudCoverPct?: number
    gsdM?: number
    spot?: 'clear' | 'cirrus' | 'cloud' | 'shadow' | 'unknown'
  }
}

/** The query keys a fallback link adds for its pass (api/_lib/share.ts reads the same set). */
export const DEEP_LINK_PASS_KEYS = ['sat', 'norad', 'verdict', 't', 'alt', 'off', 'hdg', 'collection', 'item', 'cloud', 'gsd', 'spot', 'sv'] as const

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v)

/**
 * Fallback deep link when the share service is unavailable: `/?q=lat,lon&n=label&p=passId`, plus, with
 * `pass`, the pass itself (sat, norad, verdict, t, alt, off, hdg and the capture: collection, item,
 * cloud, gsd, spot), so the link unfurls to that very pass. Coordinates are rounded to ~1 km.
 */
export function deepLink(origin: string, label: string, lat: number, lon: number, passId: string, pass?: DeepLinkPass): string {
  const r = roundedPlace(lat, lon)
  const p = new URLSearchParams()
  p.set('q', `${r.lat.toFixed(SHARE_DECIMALS)},${r.lon.toFixed(SHARE_DECIMALS)}`)
  p.set('n', label)
  p.set('p', passId)
  if (pass) {
    p.set('sat', pass.satName)
    p.set('norad', String(Math.round(pass.norad)))
    p.set('verdict', pass.verdict)
    p.set('t', String(Math.round(pass.tClosest)))
    if (finite(pass.altitudeKm)) p.set('alt', String(Math.round(pass.altitudeKm)))
    if (finite(pass.offNadirDeg)) p.set('off', pass.offNadirDeg.toFixed(1))
    if (finite(pass.headingDeg)) p.set('hdg', String(Math.round(pass.headingDeg) % 360))
    const c = pass.capture
    if (c) {
      p.set('collection', c.collection)
      p.set('item', c.itemId)
      if (finite(c.cloudCoverPct)) p.set('cloud', String(Math.round(c.cloudCoverPct)))
      if (finite(c.gsdM)) p.set('gsd', String(Math.round(c.gsdM * 100) / 100))
      if (c.spot) p.set('spot', c.spot)
    }
    // N: the card's "7 satellites watched Waterloo." (owner)
    if (finite(pass.satellites) && pass.satellites >= 1) p.set('sv', String(Math.round(pass.satellites)))
  }
  return `${origin}/?${p.toString()}`
}

export function shareLink(origin: string, id: string): string {
  return `${origin}/s/${encodeURIComponent(id)}`
}

export interface PostTextInput {
  verdict: Pass['verdict']
  satName: string
  placeLabel: string
  altitudeKm: number
  /** "Sun 1 Nov" */
  localDay: string
  /** "11:21" */
  localTime: string
  /** e.g. "10 m" */
  resolution?: string
  /** The capture's cloud (scene %, spot class): a clouded picture says what it saw (cloudWords), not "the actual image". */
  cloud?: { pct?: number; spot?: string }
}

/** The credit every post ends with, on its own line just before the link (R3-14). */
export const POST_CREDIT = 'via @armaangupt0'

/** X's limit, and what any link costs in it (t.co wraps every URL to 23 characters). */
export const X_MAX = 280
export const X_LINK = 23

/**
 * Length as X counts it (twitter-text v3 weights): code points in the Latin, General Punctuation and similar
 * ranges count 1, everything else (CJK, emoji, …) 2. URLs are not in post text (the link is added after it).
 */
export function xLength(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    n += c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037) ? 1 : 2
  }
  return n
}

/**
 * Post text stays within this, as X counts it: with a newline and the 23-character link after it, a post is
 * never over 280 (R3-14).
 */
export const POST_MAX = X_MAX - 1 - X_LINK

/** The line that turns a reader into the next person to look (share SH4). */
const HOOK = {
  watched: 'Something watched you this week too.',
  passed: 'What passed over you this week?',
} as const

/**
 * Body paragraphs + the credit line, kept within POST_MAX: the invitation is dropped first, then the lead is
 * cut with an ellipsis. The credit always stays, as the last line.
 */
function withCredit(lead: string, hook: string): string {
  const credit = `\n${POST_CREDIT}`
  const full = `${lead}\n\n${hook}${credit}`
  if (xLength(full) <= POST_MAX) return full
  if (xLength(lead + credit) <= POST_MAX) return lead + credit
  // X counts the ellipsis (U+2026) as 2.
  const room = POST_MAX - xLength(credit) - xLength('…')
  let cut = ''
  for (const ch of lead) {
    if (xLength(cut + ch) > room) break
    cut += ch
  }
  return `${cut.trimEnd()}…${credit}`
}

/**
 * Prefilled post: precise, no hype, no hashtags, a paragraph that invites the reader to look up their own
 * place, and the credit on the last line ("via @armaangupt0", R3-14). The invitation is dropped only if a
 * very long place name would push the post past POST_MAX.
 */
export function postText(i: PostTextInput): string {
  const alt = `${Math.round(i.altitudeKm)} km`
  const when = `${i.localDay} at ${i.localTime} local`
  let lead: string
  let hook: string
  switch (i.verdict) {
    case 'imaged': {
      const words = i.cloud ? cloudWords(i.cloud.pct, i.cloud.spot) : undefined
      lead = words
        ? `${i.satName} watched ${i.placeLabel} from ${alt} up on ${when}. ${words.post}`
        : `${i.satName} watched ${i.placeLabel} from ${alt} up on ${when}. ${i.resolution ? `${i.resolution} per pixel; this` : 'This'} is the actual image.`
      hook = HOOK.watched
      break
    }
    case 'likely':
      lead = `${i.satName} swept over ${i.placeLabel} from ${alt} up on ${when}. Its camera's swath covered the spot.`
      hook = HOOK.passed
      break
    case 'could':
      lead = `${i.satName} passed within view of ${i.placeLabel} on ${when}. It could have pointed here. Its operator doesn't say whether it did.`
      hook = HOOK.passed
      break
    case 'overhead':
      lead = `${i.satName} passed ${alt} over ${i.placeLabel} on ${when}.`
      hook = HOOK.passed
      break
  }
  return withCredit(lead, hook)
}

export interface SummaryLinkInput {
  label: string
  lat: number
  lon: number
  /** N: distinct satellites that watched the place (any pass; geostationary excluded), as the results headline (R3-13) */
  satellites: number
  /** The four verdict counts; `imaged` is K, the photos made public this week */
  counts: { imaged: number; likely: number; could: number; overhead: number }
  /** The archives didn't answer (K unknown) */
  archiveDown?: boolean
  /** The archives were still answering (K is a floor) */
  partial?: boolean
  windowEnd: number
  best?: { collection: string; itemId: string; satName: string; tClosest: number; gsdM?: number }
}

/**
 * A week's summary link (share SH6): the place link (`/?q=…&n=…`, which recomputes the week for whoever
 * opens it) plus the numbers its unfurl card prints, so nothing has to be stored. Coordinates are
 * rounded to ~1 km like every share.
 */
export function summaryLink(origin: string, i: SummaryLinkInput): string {
  const r = roundedPlace(i.lat, i.lon)
  const p = new URLSearchParams()
  p.set('q', `${r.lat.toFixed(SHARE_DECIMALS)},${r.lon.toFixed(SHARE_DECIMALS)}`)
  p.set('n', i.label)
  p.set('sv', String(Math.round(i.satellites)))
  p.set('sc', [i.counts.imaged, i.counts.likely, i.counts.could, i.counts.overhead].map((n) => Math.round(n)).join(','))
  p.set('sw', String(Math.round(i.windowEnd)))
  if (i.archiveDown) p.set('sa', '1')
  else if (i.partial) p.set('sp', '1')
  if (i.best) {
    p.set('bc', i.best.collection)
    p.set('bi', i.best.itemId)
    p.set('bs', i.best.satName)
    p.set('bt', String(Math.round(i.best.tClosest)))
    if (i.best.gsdM !== undefined) p.set('bg', String(Math.round(i.best.gsdM * 100) / 100))
  }
  return `${origin}/?${p.toString()}`
}

/**
 * "31 satellites watched Waterloo this week. 12 photos were made public." (R3-13: the results headline, N and K),
 * then the invitation and the credit (R3-14).
 */
export function summaryPostText(i: { placeLabel: string; satellites: number; photos: number; archiveDown?: boolean; partial?: boolean }): string {
  const lead = `${summaryHeadline(i)} ${photosSentence(i.photos, i)}`
  return withCredit(lead, i.satellites > 0 ? HOOK.watched : HOOK.passed)
}

/**
 * X (Twitter) web intent. The link goes inside the text, on its own line after the credit (R3-14): with a
 * separate `url` parameter X would append it after a space, on the credit's line.
 */
export function xIntentUrl(text: string, url: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(`${text}\n${url}`)}`
}
