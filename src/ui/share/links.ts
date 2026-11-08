/**
 * Share links and post text (pure).
 *
 * Privacy: a share never carries the exact searched point. Coordinates are rounded to 2 decimals
 * (≈ 1.1 km of latitude, less of longitude), and the card's crop is centred on that rounded point.
 */
import type { Pass } from '@/types'

/** 2 decimals of a degree ≈ 1.1 km north–south. */
export const SHARE_DECIMALS = 2

export function roundCoord(v: number, decimals = SHARE_DECIMALS): number {
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

export function roundedPlace(lat: number, lon: number): { lat: number; lon: number } {
  return { lat: roundCoord(lat), lon: roundCoord(lon) }
}

/** Fallback deep link when the share service is unavailable: `/?q=lat,lon&n=label&p=passId`. */
export function deepLink(origin: string, label: string, lat: number, lon: number, passId: string): string {
  const r = roundedPlace(lat, lon)
  const p = new URLSearchParams()
  p.set('q', `${r.lat.toFixed(SHARE_DECIMALS)},${r.lon.toFixed(SHARE_DECIMALS)}`)
  p.set('n', label)
  p.set('p', passId)
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
}

/** Prefilled post. Precise, no hype, no hashtags. Stays well under 280 chars with a link. */
export function postText(i: PostTextInput): string {
  const alt = `${Math.round(i.altitudeKm)} km`
  const when = `${i.localDay} at ${i.localTime} local`
  switch (i.verdict) {
    case 'imaged':
      return `${i.satName} photographed ${i.placeLabel} from ${alt} up on ${when}${i.resolution ? `, at ${i.resolution} per pixel` : ''}. This is the actual image.`
    case 'likely':
      return `${i.satName} crossed ${alt} above ${i.placeLabel} on ${when}, with ${i.placeLabel} inside its swath.`
    case 'could':
      return `${i.satName} passed within view of ${i.placeLabel} on ${when}. It could have pointed here. There is no way to know whether it did.`
    case 'overhead':
      return `${i.satName} passed ${alt} over ${i.placeLabel} on ${when}.`
  }
}

/** X (Twitter) web intent. */
export function xIntentUrl(text: string, url: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
}
