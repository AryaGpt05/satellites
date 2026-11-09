/**
 * What the lazily loaded src/app/telemetry.ts needs from the app, handed over by src/main.tsx. The store, the
 * catalog lookup and cityLevelLabel are in the entry chunk already; `arrival` is read here, synchronously at
 * import (before the app boots), because the app soon rewrites the URL (a search writes ?q=&n=, a missing share
 * is dropped) and /s/<id> share pages redirect to /?s=<id>:
 *  - `?noanalytics=1` opts the whole tab out (sessionStorage, read by src/lib/telemetry.ts);
 *  - how the visit started (landing / deep link / share link), its referrer and query (UTM tags), including
 *    what a /s/ page stashed before redirecting (api/_lib/html.ts).
 */
export { useApp } from '@/state/store'
export { getSatInfo } from '@/engine/catalog'
export { cityLevelLabel } from '@/lib/backend'

export interface Arrival {
  entry: 'landing' | 'deep_link' | 'share_link'
  /** `?noanalytics=1` on this page or the /s/ page that redirected here (held for the tab in sessionStorage too) */
  optedOut: boolean
  referrer: string
  search: string
}

const OPT_OUT = /[?&]noanalytics=1(?:&|$)/

function readArrival(): Arrival {
  const search = location.search
  let via: { r?: unknown; q?: unknown } = {}
  let stored = false
  try {
    via = JSON.parse(sessionStorage.getItem('watched.via') ?? '{}') as typeof via
    sessionStorage.removeItem('watched.via')
    stored = sessionStorage.getItem('watched.noanalytics') === '1'
  } catch {
    /* storage blocked: `optedOut` below still carries this page's opt-out */
  }
  const viaQ = typeof via.q === 'string' ? via.q : ''
  const optedOut = stored || OPT_OUT.test(search) || OPT_OUT.test(viaQ)
  try {
    if (optedOut) sessionStorage.setItem('watched.noanalytics', '1')
  } catch {
    /* as above */
  }
  return {
    optedOut,
    entry: /^\/s\//.test(location.pathname) || /[?&]s=/.test(search) ? 'share_link' : /[?&]q=/.test(search) ? 'deep_link' : 'landing',
    referrer: typeof via.r === 'string' ? via.r : document.referrer,
    search: /[?&]utm_/.test(search) || !viaQ ? search : viaQ,
  }
}

export const arrival: Arrival = readArrival()
