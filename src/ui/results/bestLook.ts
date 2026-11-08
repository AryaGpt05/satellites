/**
 * Closest look (owner B1 + D1): exported for the controller, which preloads the cover image while the camera
 * is still flying. The ordering lives in lib/photos.ts (pure, unit-tested).
 */
import type { Report } from '@/types'
import { cardUrl, orderPhotos } from './lib/photos'

export { pickBestLook, isClouded, type BestLook } from './lib/bestLook'

/**
 * The exact URL the summary's cover photo AND the pass view request (so a preload is a cache hit). This is
 * photo #1 of the gallery: the closest clear look, else the report's clear cover from before the window
 * (`report.clearCover`), else the least cloudy capture.
 */
export function bestLookImageUrl(report: Report): string | undefined {
  const cover = orderPhotos(report).cover
  return cover ? cardUrl(cover.photo.capture) : undefined
}
