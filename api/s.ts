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
 *
 * Place mode (share SH7): an address-bar link, /?q=43.47,-80.54&n=Waterloo, fetched by a link
 * unfurler (vercel.json sends only bot user agents here; people get the SPA). Title "What
 * photographed Waterloo this week", the card at /api/og?kind=place…, coordinates coarsened to 0.01°,
 * and people who land here anyway are handed to the same address in the app.
 */
import { siteOrigin } from './_lib/env.js'
import { DEFAULT_CARD_ALT } from './_lib/cardSpec.js'
import { sharePageHtml } from './_lib/html.js'
import {
  SHARE_ID_RE,
  SUMMARY_KEYS,
  description,
  fetchShare,
  headline,
  placeDescription,
  placeFromParams,
  placeTitle,
  summaryDescription,
  summaryFromParams,
  summaryTitle,
} from './_lib/share.js'

/** Bump when the card design changes so unfurler caches (which key on the URL) refetch. */
export const CARD_VERSION = '2'

const GENERIC = {
  title: 'Something photographed you this week.',
  description: 'Enter any place on Earth. See every satellite that passed over it in the last 7 days, and the actual pictures they took.',
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

/** An address-bar link (`/?q=lat,lon&n=label[&p=passId]`) seen by a link unfurler. */
function placePage(q: URLSearchParams, origin: string): Response {
  const place = placeFromParams(q)
  if (!place) {
    return html(
      sharePageHtml({ ...GENERIC, canonical: `${origin}/`, image: `${origin}/og-default.png`, imageAlt: DEFAULT_CARD_ALT, redirect: '/' }),
      200,
      'public, max-age=300, s-maxage=3600',
    )
  }
  const coords = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`
  const app = new URLSearchParams({ q: coords, n: place.label })
  const pass = q.get('p')
  if (pass && /^[0-9A-Za-z_.:-]{1,40}$/.test(pass)) app.set('p', pass)
  // A week's summary (SH6) rides in the link itself: its card shows the counts and the best look.
  const summary = summaryFromParams(q)
  const card = new URLSearchParams(
    summary
      ? { kind: 'summary', q: coords, n: place.label, ...Object.fromEntries(SUMMARY_KEYS.flatMap((k) => (q.get(k) ? [[k, q.get(k)!]] : []))), v: CARD_VERSION }
      : { kind: 'place', place: place.label, lat: place.lat.toFixed(2), lon: place.lon.toFixed(2), v: CARD_VERSION },
  )
  return html(
    sharePageHtml({
      title: summary ? summaryTitle(summary) : placeTitle(place),
      description: summary ? summaryDescription(summary) : placeDescription(place),
      canonical: `${origin}/?${app.toString()}`,
      image: `${origin}/api/og?${card.toString()}`,
      imageAlt: summary ? `${summaryTitle(summary)}: the share card, with the clearest satellite picture of the week.` : DEFAULT_CARD_ALT,
      redirect: `/?${app.toString()}`,
    }),
    200,
    'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
  )
}

export async function handleSharePage(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const origin = siteOrigin(request)
  const raw = url.searchParams.get('id') ?? ''
  const id = raw.trim().toLowerCase()

  if (!raw && url.searchParams.has('q')) return placePage(url.searchParams, origin)

  if (!SHARE_ID_RE.test(id)) {
    return html(
      sharePageHtml({ ...GENERIC, canonical: `${origin}/`, image: `${origin}/og-default.png`, imageAlt: DEFAULT_CARD_ALT, redirect: '/' }),
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
      sharePageHtml({ ...GENERIC, canonical: `${origin}/`, image: `${origin}/og-default.png`, imageAlt: DEFAULT_CARD_ALT, redirect: '/' }),
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
