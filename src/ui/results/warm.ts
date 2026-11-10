/**
 * Before the results' first paint: start the photos the panel asks for first, so they are not requested only once it
 * mounts. Planetary Computer renders every crop on demand (~1–2 s, no cache on its side), so a request started while
 * the camera is still flying is a photo already there when the panel lands.
 *
 *  - the pass list's eager thumbnails (the first EAGER_THUMBS rows of each group, PRD-06): at once, they are tiny;
 *  - the gallery's next photos (±NEAR around the hero, Gallery.tsx), and the thumbnail of the hero's own capture:
 *    only once the hero is decoded, so neither the download nor the tone step (one pixels worker) delays the hero,
 *    and that thumbnail takes the curve the hero measured (pixels.ts: the shared curve), as it does today.
 *
 * A guess that the final report changes (another order) costs one request; the panel finds the rest in flight or
 * decoded (images.ts: one request per URL).
 */
import type { Report } from '@/types'
import { warmPhoto } from './images'
import { captureFor, isDailyMosaic } from './lib/captures'
import { cardUrl, filterPhotos, thumbUrl } from './lib/photos'
import { getResultsModel } from './model'

/** Thumbnails of the first rows of each group load with the report, not when scrolled near (PRD-06). */
export const EAGER_THUMBS = 3
/** The gallery decodes this many photos either side of the current one (Gallery.tsx). */
export const GALLERY_NEAR = 2
/** At most this many thumbnails are started before the paint. */
const MAX_THUMBS = 6

/**
 * Warm the first photos of `report`'s panel (see the header). `heroDecoded` settles when the photo that leads it is
 * decoded (or given up on); `withGallery` false skips the gallery's neighbours (a share or pass link opens on that
 * pass's own view). Never throws.
 */
export function warmFirstPhotos(report: Report, heroDecoded: Promise<unknown>, withGallery = true): void {
  try {
    const model = getResultsModel(report)
    const photos = filterPhotos(model.photos, 'all')
    const lead = photos[0]?.capture.id
    const after: string[] = []
    let thumbs = 0
    for (const g of model.groups) {
      for (const item of g.items.slice(0, EAGER_THUMBS)) {
        if (item.kind !== 'pass' || thumbs >= MAX_THUMBS) continue
        const c = captureFor(report, item.pass)
        if (!c || isDailyMosaic(c)) continue
        thumbs++
        if (c.id === lead) after.push(thumbUrl(c))
        else warmPhoto(thumbUrl(c))
      }
    }
    if (withGallery) for (const p of photos.slice(1, 1 + GALLERY_NEAR)) after.push(cardUrl(p.capture))
    if (after.length) void heroDecoded.then(() => after.forEach(warmPhoto), () => after.forEach(warmPhoto))
  } catch (err) {
    console.error(err)
  }
}
