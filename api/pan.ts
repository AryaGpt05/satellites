/**
 * GET /api/pan?bbox=…&crs=…&t=…  — Landsat 8/9's 15 m pan band for one app crop (see _lib/pan.ts).
 *
 * The CDSE OAuth client (CDSE_CLIENT_ID / CDSE_CLIENT_SECRET, server-side only) gets a token, kept for its lifetime by
 * the warm instance. A crop is a fixed picture of a past capture, so a success is cached at the edge for a year
 * (repeat views never reach CDSE or count against its free quota). Anything else answers without a body and is not
 * cached for long; the client then keeps the photo it has (photos.ts / pixels.ts fall back to the 30 m layer).
 *
 *   200  image/png (8-bit grey, √ encoded; 0 = no data)
 *   400  not an app crop · 404 no Landsat pan at that place and hour · 502 CDSE refused or unreachable
 *   503  not configured
 */
import { parsePanQuery, processBody } from './_lib/pan.js'

const TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token'
const PROCESS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/process'
const TIMEOUT_MS = 12_000

let token: { value: string; until: number } | null = null

async function accessToken(): Promise<string | null> {
  if (token && token.until > Date.now() + 60_000) return token.value
  const id = process.env.CDSE_CLIENT_ID?.trim()
  const secret = process.env.CDSE_CLIENT_SECRET?.trim()
  if (!id || !secret) return null
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`token ${res.status}`)
  const j = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!j.access_token) throw new Error('token')
  token = { value: j.access_token, until: Date.now() + (j.expires_in ?? 300) * 1000 }
  return token.value
}

const empty = (status: number, cache = 'public, max-age=300, s-maxage=300') => new Response(null, { status, headers: { 'cache-control': cache } })

export async function handlePan(req: Request): Promise<Response> {
  if (req.method !== 'GET') return empty(405, 'no-store')
  const parsed = parsePanQuery(new URL(req.url).searchParams, Date.now())
  if (typeof parsed === 'string') return empty(400, 'public, max-age=86400')
  try {
    const tok = await accessToken()
    if (!tok) return empty(503, 'no-store')
    const res = await fetch(PROCESS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'image/png' },
      body: JSON.stringify(processBody(parsed)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 401) token = null
    if (!res.ok) return empty(res.status === 400 || res.status === 404 ? 404 : 502)
    return new Response(await res.arrayBuffer(), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=604800, s-maxage=31536000, immutable',
      },
    })
  } catch {
    return empty(502, 'no-store')
  }
}

export default { fetch: handlePan }
