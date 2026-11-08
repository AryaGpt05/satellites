/**
 * GET /s/:id  (vercel.json rewrites it to /api/s?id=:id)
 *
 * The URL people paste into X / iMessage / Slack. Unfurlers get real Open Graph tags for the
 * shared pass, with og:image pointing at the /api/og card; people are sent straight on to the
 * app at /?s=<id> (meta refresh + location.replace), which reopens the pass.
 *
 *   found        → 200, specific title/description/card, cached at the edge for a day
 *   not found    → 404, generic tags, people go to the landing page
 *   db unreachable → 200, generic tags but the card URL still names the share, cached briefly
 */
import { siteOrigin } from './_lib/env.js'
import { sharePageHtml } from './_lib/html.js'
import { SHARE_ID_RE, description, fetchShare, headline } from './_lib/share.js'

/** Bump when the card design changes so unfurler caches (which key on the URL) refetch. */
export const CARD_VERSION = '1'

const GENERIC = {
  title: 'Overflight: what photographed you from orbit',
  description: 'Enter any place on Earth. See every satellite that passed over it this week, and the actual pictures they took.',
}

function html(body: string, status: number, cacheControl: string): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  })
}

export async function handleSharePage(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const origin = siteOrigin(request)
  const raw = url.searchParams.get('id') ?? ''
  const id = raw.trim().toLowerCase()

  if (!SHARE_ID_RE.test(id)) {
    return html(
      sharePageHtml({ ...GENERIC, canonical: `${origin}/`, image: `${origin}/og-default.png`, imageAlt: GENERIC.title, redirect: '/' }),
      404,
      'public, max-age=300, s-maxage=3600',
    )
  }

  const canonical = `${origin}/s/${id}`
  const redirect = `/?s=${id}`
  const card = `${origin}/api/og?id=${id}&v=${CARD_VERSION}`
  const r = await fetchShare(id)

  if (r.status === 'found') {
    const title = headline(r.share)
    return html(
      sharePageHtml({ title, description: description(r.share), canonical, image: card, imageAlt: title, redirect }),
      200,
      'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
    )
  }
  if (r.status === 'missing') {
    return html(
      sharePageHtml({ ...GENERIC, canonical: `${origin}/`, image: `${origin}/og-default.png`, imageAlt: GENERIC.title, redirect: '/' }),
      404,
      'public, max-age=60, s-maxage=600',
    )
  }
  // Couldn't reach the database: don't 404 a link that may well be valid.
  return html(
    sharePageHtml({ ...GENERIC, canonical, image: card, imageAlt: GENERIC.title, redirect }),
    200,
    'public, max-age=60, s-maxage=60',
  )
}

export default {
  fetch: handleSharePage,
}
