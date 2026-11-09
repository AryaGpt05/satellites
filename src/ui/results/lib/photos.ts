/**
 * The photos of a report, in the one order every view uses (owner requests B1 + D1, final):
 *
 *   #1  the COVER ("Closest look"): the most zoomed-in CLEAR photo of the window (Sentinel-2 10 m beats Landsat
 *       30 m beats VIIRS 375 m). What counts as clear, and how equally zoomed-in photos are ranked, is
 *       src/lib/clarity.ts (shared with the globe's cover prefetch): not clouded over (spot ≠ cloud and scene
 *       cloud < 70 %) and, where the archive's per-pixel mask was read, at least 60 % of the photo's square
 *       showing the ground; ties go to the clear spot, the clearer square, the higher sun, the straighter view,
 *       then the newest. With no clear photo, a partly clear one leads the same way.
 *       · no clear DETAILED photo in the window → `report.clearCover` (the last clear Sentinel-2 / Landsat
 *         look from before the window; no pass, never counted), labelled "Last clear look";
 *       · no clear image at all → the least cloudy detailed capture, labelled "Clouded over";
 *       · no detailed capture at all → the sharpest weather mosaic (lit well, then newest).
 *   then every other photo of the window, NEWEST FIRST (by the pass's closest approach). Clouded ones stay,
 *   honestly labelled.
 *
 * Weather mosaics (250–375 m daily) are photos too. The gallery filter narrows the same order to
 * Detailed (10–30 m) or Weather (250 m+).
 *
 * Pure: unit-tested in lib.test.ts.
 */
import type { Capture, Pass, Report, SpotCloud } from '@/types'
import { pickLead, SPOT_RANK as CLARITY_SPOT_RANK, type Ranked } from '@/lib/clarity'
import { isClouded } from './bestLook'
import { captureFor, cropSpec, displayUrl, isDetailed, type CropSpec } from './captures'

export interface Photo {
  /** Stable key: the capture id (one capture per pass) */
  key: string
  capture: Capture
  /** The pass that took it; undefined for the clear cover from before the window */
  pass?: Pass
  /** Sentinel-2 / Landsat (10–30 m) vs a daily weather mosaic (250–375 m) */
  kind: 'detailed' | 'mosaic'
  /** Clouded over (detailed only): scene ≥ 70 % or cloud at the spot */
  clouded: boolean
}

/** Why the cover is the cover (drives its label). */
export type CoverKind = 'closest' | 'lastClear' | 'clouded'

export interface PhotoSet {
  /** Every photo, cover first, then newest first */
  photos: Photo[]
  /** The cover (photos[0]) and why, or undefined when there is no photo at all */
  cover?: { photo: Photo; why: CoverKind }
  /** Photos of the window only (the clear cover from before it excluded): what "K photos" counts */
  windowCount: number
}

export type PhotoFilter = 'all' | 'detailed' | 'weather'

/** Spot clarity rank (owner B1): clear > cirrus > unknown > shadow > cloud. */
export const SPOT_RANK: Record<SpotCloud, number> = CLARITY_SPOT_RANK

/** Sun high enough that a daily true-colour mosaic shows the ground, not twilight. */
const MOSAIC_MIN_SUN_DEG = 10

const tOf = (p: Photo) => p.pass?.tClosest ?? p.capture.datetime

function toPhoto(capture: Capture, pass?: Pass): Photo {
  const mosaic = !isDetailed(capture)
  return { key: capture.id, capture, pass, kind: mosaic ? 'mosaic' : 'detailed', clouded: !mosaic && isClouded(capture) }
}

/** A photo as the lead ranking (src/lib/clarity.ts) sees it. */
const ranked = (p: Photo): Ranked & { photo: Photo } => ({
  photo: p,
  capture: p.capture,
  t: tOf(p),
  sunDeg: p.pass?.sunElevationDeg,
  offNadirDeg: p.pass?.offNadirDeg,
})

/** Weather mosaics carry no per-pixel cloud: the sharpest, then a well-lit day, then the newest. */
function byMosaic(a: Photo, b: Photo): number {
  const lit = (p: Photo) => Number((p.pass?.sunElevationDeg ?? 0) >= MOSAIC_MIN_SUN_DEG)
  return a.capture.gsdM - b.capture.gsdM || lit(b) - lit(a) || tOf(b) - tOf(a)
}

/** The window's photos: imaged passes with their capture (one row per capture). */
function windowPhotos(report: Pick<Report, 'passes' | 'captures'>): Photo[] {
  const out: Photo[] = []
  const seen = new Set<string>()
  for (const pass of report.passes) {
    if (pass.verdict !== 'imaged') continue
    const c = captureFor(report, pass)
    if (!c || seen.has(c.id)) continue
    seen.add(c.id)
    out.push(toPhoto(c, pass))
  }
  return out
}

/** The cover among the window's photos only (no clear cover): what pickBestLook returns. */
export function windowCover(photos: Photo[]): { photo: Photo; why: CoverKind } | undefined {
  const lead = pickLead(photos.filter((p) => p.kind === 'detailed').map(ranked))
  if (lead) return { photo: lead.item.photo, why: lead.tier === 2 ? 'clouded' : 'closest' }
  const mosaics = photos.filter((p) => p.kind === 'mosaic')
  if (mosaics.length) return { photo: [...mosaics].sort(byMosaic)[0], why: 'closest' }
  return undefined
}

export function orderPhotos(report: Pick<Report, 'passes' | 'captures' | 'clearCover'>): PhotoSet {
  const inWindow = windowPhotos(report)
  const newest = [...inWindow].sort((a, b) => tOf(b) - tOf(a))
  let cover = windowCover(inWindow)
  const hasClearDetailed = inWindow.some((p) => p.kind === 'detailed' && !p.clouded)
  const cc = report.clearCover
  // No clear detailed photo this week: the last clear look from before the window leads (owner D1).
  if (!hasClearDetailed && cc && !inWindow.some((p) => p.key === cc.id)) cover = { photo: { ...toPhoto(cc), clouded: false }, why: 'lastClear' }
  if (!cover) return { photos: [], windowCount: 0 }
  const lead = cover.photo
  return { photos: [lead, ...newest.filter((p) => p.key !== lead.key)], cover, windowCount: inWindow.length }
}

export function filterPhotos(photos: Photo[], filter: PhotoFilter): Photo[] {
  if (filter === 'all') return photos
  return photos.filter((p) => (filter === 'detailed' ? p.kind === 'detailed' : p.kind === 'mosaic'))
}

/** Which filters have anything in them (the control disables the empty ones). */
export function filterCounts(photos: Photo[], windowOnly = false): Record<PhotoFilter, number> {
  const list = windowOnly ? photos.filter((p) => !!p.pass) : photos
  let detailed = 0
  for (const p of list) if (p.kind === 'detailed') detailed++
  return { all: list.length, detailed, weather: list.length - detailed }
}

// ── one canonical URL per (capture, size) ─────────────────────────────────────────────────

/** The card / pass-view image: the crop the hero, the gallery and the pass all share (preload = cache hit). */
export const cardSpec = (c: Pick<Capture, 'collection'>): CropSpec => cropSpec(c.collection)
export const cardUrl = (c: Capture) => displayUrl(c, cardSpec(c))

/** List rows and the lightbox filmstrip. */
export const THUMB_PX = 112
export const thumbUrl = (c: Capture) => displayUrl(c, { ...cardSpec(c), px: THUMB_PX })

/**
 * The lightbox's sharper render of the same area (owner B2): 2048 px for Sentinel-2 / Landsat, so zooming in
 * shows real pixels. Weather mosaics and geostationary frames are already at native scale: no second request.
 */
export const HIRES_PX = 2048
export function hiResUrl(c: Capture): string | undefined {
  if (!isDetailed(c)) return undefined
  return displayUrl(c, { ...cardSpec(c), px: HIRES_PX })
}

/** Crop width in km (the card and the lightbox show the same area). */
export const cropWidthKm = (c: Pick<Capture, 'collection'>) => cardSpec(c).halfSizeKm * 2

