/**
 * Share links and post text (pure).
 *
 * Privacy: a share never carries the exact searched point. Coordinates are rounded to 2 decimals
 * (≈ 1.1 km of latitude, less of longitude), and the card's crop is centred on that rounded point.
 */
import type { Pass } from '@/types'
import { cloudWords } from '../../../api/_lib/cardSpec'

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
export const DEEP_LINK_PASS_KEYS = ['sat', 'norad', 'verdict', 't', 'alt', 'off', 'hdg', 'collection', 'item', 'cloud', 'gsd', 'spot'] as const

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

/** Post text stays within this many characters, leaving room for the link on X (280, links count 23). */
export const POST_MAX = 230

/** The line that turns a reader into the next person to look (share SH4). */
const HOOK = {
  photographed: 'Something watched you this week too.',
  passed: 'What passed over you this week?',
} as const

/**
 * Prefilled post: precise, no hype, no hashtags, and a last line that invites the reader to look up
 * their own place. Two paragraphs; the invitation is dropped only if a very long place name would push
 * the post past POST_MAX.
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
        ? `${i.satName} photographed ${i.placeLabel} from ${alt} up on ${when}. ${words.post}`
        : `${i.satName} photographed ${i.placeLabel} from ${alt} up on ${when}. ${i.resolution ? `${i.resolution} per pixel; this` : 'This'} is the actual image.`
      hook = HOOK.photographed
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
  const full = `${lead}\n\n${hook}`
  if (full.length <= POST_MAX) return full
  return lead.length <= POST_MAX ? lead : `${Array.from(lead).slice(0, POST_MAX - 1).join('')}…`
}

export interface SummaryLinkInput {
  label: string
  lat: number
  lon: number
  /** Distinct satellites that photographed the place in detail (Sentinel-2 / Landsat; R2SH5) */
  satellites: number
  counts: { imaged: number; likely: number; could: number; overhead: number }
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
 * "2 satellites photographed Waterloo in detail this week. The clearest one, Sentinel-2C, from 795 km up."
 * + the invitation. `satellites` counts detailed pictures only (as the results headline, R2SH5).
 */
export function summaryPostText(i: { placeLabel: string; satellites: number; passes: number; best?: { satName: string; altitudeKm?: number } }): string {
  const n = i.satellites
  let lead: string
  if (n > 0) {
    lead = `${n} ${n === 1 ? 'satellite' : 'satellites'} photographed ${i.placeLabel} in detail this week.`
    if (i.best) lead += ` The clearest one, ${i.best.satName}${i.best.altitudeKm !== undefined ? `, from ${Math.round(i.best.altitudeKm)} km up` : ''}.`
  } else lead = `${i.passes.toLocaleString('en-US')} satellite passes crossed ${i.placeLabel} this week. None caught a clear picture.`
  const full = `${lead}\n\n${n > 0 ? HOOK.photographed : HOOK.passed}`
  return full.length <= POST_MAX ? full : lead
}

/** X (Twitter) web intent. */
export function xIntentUrl(text: string, url: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
}
