/**
 * GET /api/og — the 1200×630 share card (PNG).
 *
 *   /api/og?id=<shareId>          a stored share (read via get_share, without counting a view)
 *   /api/og?place=…&lat=…&…       explicit parameters (see shareFromParams), no database needed
 *   /api/og                       the default card, also baked into public/og-default.png
 *
 * The left square is the real archived crop, fetched server-side from Planetary Computer / NASA
 * GIBS and embedded. If the archive is slow or has nothing, the card draws the pass geometry
 * instead and is cached briefly so a later request can pick the image up.
 *
 * Runs on the Node.js runtime (fonts are read from api/_fonts via fs).
 */
import { CARD_H, CARD_W, PLATE, defaultCard, shareCard } from './_lib/card.js'
import { displayHost, siteOrigin } from './_lib/env.js'
import { loadFonts } from './_lib/fonts.js'
import { loadOg } from './_lib/og-runtime.js'
import { cropPlan, fetchImageDataUri, type CropPlan } from './_lib/imagery.js'
import { SHARE_ID_RE, fetchShare, shareFromParams, type ShareRecord } from './_lib/share.js'

/** PC renders a 630² crop in 1–3 s, occasionally much longer; stay well inside maxDuration. */
const IMAGE_TIMEOUT_MS = 9000

const CACHE = {
  /** Shares are immutable once written: cache hard at the edge. */
  final: 'public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800',
  /** Rendered without the image (archive slow/down) or share not found: retry soon. */
  degraded: 'public, max-age=300, s-maxage=300',
  default: 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800',
} as const

async function render(element: ReturnType<typeof defaultCard>, cacheControl: string, status = 200): Promise<Response> {
  const [{ ImageResponse }, fonts] = await Promise.all([loadOg(), loadFonts()])
  const img = new ImageResponse(element, { width: CARD_W, height: CARD_H, fonts, status })
  // ImageResponse streams; buffer it so errors surface here (and the response has a length).
  const body = await img.arrayBuffer()
  return new Response(body, {
    status,
    headers: {
      'content-type': 'image/png',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
    },
  })
}

type CardImage =
  | { kind: 'image'; dataUri: string; plan: CropPlan }
  | { kind: 'none' } //      not an imaged share: the geometry plate is the design
  | { kind: 'permanent' } // imaged, but no capture or one that can't be cropped here (final)
  | { kind: 'transient' } // the archive was slow or failed just now (retry soon)

async function cardImage(share: ShareRecord): Promise<CardImage> {
  if (share.verdict !== 'imaged') return { kind: 'none' }
  const plan = share.capture ? cropPlan(share.capture, share.lat, share.lon, PLATE) : null
  if (!plan) return { kind: 'permanent' }
  const dataUri = await fetchImageDataUri(plan.url, IMAGE_TIMEOUT_MS)
  return dataUri ? { kind: 'image', dataUri, plan } : { kind: 'transient' }
}

export async function handleOg(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const host = displayHost(siteOrigin(request))
  try {
    let share: ShareRecord | null = null
    let degraded = false
    const id = url.searchParams.get('id')
    if (id !== null) {
      if (SHARE_ID_RE.test(id)) {
        const r = await fetchShare(id)
        if (r.status === 'found') share = r.share
        else degraded = true
      } else degraded = true
    } else {
      share = shareFromParams(url.searchParams)
    }

    if (!share) return await render(defaultCard({ host }), degraded ? CACHE.degraded : CACHE.default)

    const img = await cardImage(share)
    const image = img.kind === 'image' ? { dataUri: img.dataUri, plan: img.plan } : null
    const imageMiss = img.kind === 'permanent' ? 'permanent' : 'transient'
    // Only a transient archive miss is worth re-rendering soon; everything else is final.
    const cache = degraded || img.kind === 'transient' ? CACHE.degraded : CACHE.final
    return await render(shareCard({ share, image, imageMiss, host }), cache)
  } catch (err) {
    console.error('[og] render failed', err)
    try {
      return await render(defaultCard({ host }), CACHE.degraded)
    } catch {
      return new Response('card unavailable', { status: 500, headers: { 'cache-control': 'no-store' } })
    }
  }
}

export default {
  fetch: handleOg,
}
