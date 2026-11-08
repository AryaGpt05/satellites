import { gibsWmsUrl, pcCropUrl } from '@/imagery'
import type { Share } from '@/lib/backend'
import { cropSpec } from '../results/lib/captures'

/** Planetary Computer item ids (Earth Search fallback ids can't be cropped by a URL). */
const PC_ITEM = /^(S2[A-Z]_MSIL2A_\d{8}T\d{6}_R\d{3}_T\d{2}[A-Z]{3}_\d{8}T\d{6}|L[COTE]0\d_L2S[PR]_\d{6}_\d{8}_\d{2}_[A-Z0-9]{2})$/

/**
 * Crop URL for a shared pass's picture, so a recipient sees the shared picture the moment the link
 * opens (results R15), built from the share's stored capture and centred on its rounded point.
 *
 * Framed like the app's pass detail (results' cropSpec: a 10 km square for Sentinel-2), not like the
 * share card, so the picture shown while the recipient's own report computes is the very one the pass
 * view settles on: no zoom jump when the results land. Undefined when the share has no capture or
 * one that can't be cropped by URL.
 */
export function shareCropUrl(share: Share, px: number): string | undefined {
  const c = share.capture
  if (!c || !Number.isFinite(share.lat) || !Number.isFinite(share.lon)) return undefined
  const at = { lat: share.lat, lon: share.lon }
  const opts = cropSpec(c.collection, Math.round(px))
  if ((c.collection === 'sentinel-2-l2a' || c.collection === 'landsat-c2-l2') && c.provider !== 'earth-search' && PC_ITEM.test(c.itemId)) {
    // JPEG: the same render at a fraction of the PNG's size (as results' displayUrl).
    return pcCropUrl(c.collection, c.itemId, at, opts).replace(/\.png\?/, '.jpg?')
  }
  if (c.collection.startsWith('gibs-')) {
    const [layer, time] = c.itemId.split('@')
    return layer && time ? gibsWmsUrl(layer, time, at, opts) : undefined
  }
  return undefined
}
