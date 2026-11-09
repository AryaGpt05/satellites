/**
 * Backend module sandbox: ?sandbox=backend
 *
 * Every button calls the real Supabase RPCs through src/lib/backend.ts with the publishable key
 * from .env.local, and prints the raw result, latency and state. The share fixture below is a
 * real pass (SGP4 from CelesTrak elements) and a real Sentinel-2C archive item over Waterloo; rows
 * it writes are tagged "(sandbox)" so scripts/backend-purge-dev.sh can remove them.
 * Never imported by production code.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Capture, Pass, Place } from '@/types'
import { Button, Label, Readout, Rule, Tag, fmtInt, fmtLat, fmtLon } from '@/ui/system'
import {
  backendConfigured,
  cityLevelLabel,
  createShare,
  getShare,
  getStats,
  recordLookup,
  shareCardUrl,
  type CreatedShare,
  type Share,
  type Stats,
} from '@/lib/backend'

// ── Fixtures (sandbox only) ─────────────────────────────────────────────────────────────────

const SANDBOX_PLACE: Place = {
  label: 'Overflight sandbox',
  sublabel: 'Waterloo, Ontario, Canada',
  countryCode: 'ca',
  lat: 43.4723,
  lon: -80.5449,
  source: 'demo',
}

const S2C_PASS: Pass = {
  id: '60989-29892501',
  norad: 60989,
  tClosest: 1793550073893,
  tStart: 1793550055378,
  tEnd: 1793550092409,
  groundDistanceKm: 73.26,
  offNadirDeg: 5.26,
  elevationDeg: 84.08,
  azimuthDeg: 103.9,
  altitudeKm: 794.9,
  groundSpeedKmS: 6.714,
  headingDeg: 194.6,
  node: 'descending',
  sunElevationDeg: 31.06,
  inSwath: true,
  inFieldOfRegard: true,
  verdict: 'imaged',
  track: [],
  captureId: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
}

const S2C_CAPTURE: Capture = {
  id: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
  provider: 'planetary-computer',
  collection: 'sentinel-2-l2a',
  itemId: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803',
  platform: 'sentinel-2c',
  norad: 60989,
  datetime: 1793549661025,
  cloudCoverPct: 25.456536,
  gsdM: 10,
  cropUrl: () => '',
}

/** What recordLookup sends for the sandbox place (same coarsening as the client). */
const LOOKUP_SENT = {
  p_lat: Math.round(SANDBOX_PLACE.lat * 10) / 10,
  p_lon: Math.round(SANDBOX_PLACE.lon * 10) / 10,
  p_country: SANDBOX_PLACE.countryCode,
  p_label: cityLevelLabel(SANDBOX_PLACE) ?? null,
}

// ── A tiny call runner ──────────────────────────────────────────────────────────────────────

type Call<T> =
  | { state: 'idle' }
  | { state: 'busy'; since: number }
  | { state: 'done'; value: T; ms: number }
  | { state: 'empty'; ms: number } // resolved null: unconfigured, unreachable, rejected or not found

function useCall<A extends unknown[], T>(fn: (...args: A) => Promise<T | null | void>) {
  const [call, setCall] = useState<Call<T | true>>({ state: 'idle' })
  const run = useCallback(
    async (...args: A) => {
      const t0 = performance.now()
      setCall({ state: 'busy', since: t0 })
      const value = await fn(...args)
      const ms = performance.now() - t0
      // recordLookup resolves void by design; count that as done.
      if (value === undefined) setCall({ state: 'done', value: true, ms })
      else if (value === null) setCall({ state: 'empty', ms })
      else setCall({ state: 'done', value, ms })
    },
    [fn],
  )
  return [call, run] as const
}

function Status({ call, empty }: { call: Call<unknown>; empty: string }) {
  let body: ReactNode
  if (call.state === 'idle') body = <span className="t-faint">Not run</span>
  else if (call.state === 'busy') body = <span className="bkx-busy">Waiting for Supabase</span>
  else if (call.state === 'empty') body = <span className="bkx-warn">{empty}</span>
  else body = <span>OK</span>
  return (
    <div className="bkx-status t-label" aria-live="polite">
      <span>{body}</span>
      <span className="bkx-status-r">{call.state === 'done' || call.state === 'empty' ? `${fmtInt(call.ms)} MS` : '—'}</span>
    </div>
  )
}

function Json({ value }: { value: unknown }) {
  if (value === undefined) return null
  return <pre className="bkx-json t-mono">{JSON.stringify(value, null, 2)}</pre>
}

// ── Heatmap preview of stats.cells (equirectangular, 2:1) ───────────────────────────────────

function CellMap({ cells }: { cells: Stats['cells'] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = canvas.clientWidth
    const h = w / 2
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    const css = getComputedStyle(canvas)
    const bone = css.getPropertyValue('--bone').trim() || '#ece8e0'
    ctx.clearRect(0, 0, w, h)
    // Graticule every 30°.
    ctx.strokeStyle = css.getPropertyValue('--line').trim() || 'rgba(236,232,224,.1)'
    ctx.lineWidth = 1
    for (let lon = -150; lon <= 150; lon += 30) {
      const x = Math.round(((lon + 180) / 360) * w) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = Math.round(((90 - lat) / 180) * h) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    const max = cells.reduce((m, c) => Math.max(m, c[2]), 1)
    ctx.fillStyle = bone
    for (const [lat, lon, n] of cells) {
      const x = ((lon + 180) / 360) * w
      const y = ((90 - lat) / 180) * h
      const k = Math.log1p(n) / Math.log1p(max)
      ctx.globalAlpha = 0.35 + 0.65 * k
      const r = 1 + 2.5 * k
      ctx.fillRect(x - r / 2, y - r / 2, r, r)
    }
    ctx.globalAlpha = 1
  }, [cells])
  return (
    <figure className="bkx-map">
      <canvas ref={ref} aria-label={`${cells.length} looked-up cells`} />
      <figcaption className="t-label">
        <span>{fmtInt(cells.length)} {cells.length === 1 ? 'CELL' : 'CELLS'} · 0.1° GRID · ALL TIME</span>
        <span>EQUIRECTANGULAR</span>
      </figcaption>
    </figure>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────────────────────

export default function BackendSandbox() {
  const configured = backendConfigured()
  const host = (() => {
    try {
      return new URL(import.meta.env.VITE_SUPABASE_URL as string).host
    } catch {
      return null
    }
  })()

  const [stats, runStats] = useCall(useCallback(() => getStats({ fresh: true }), []))
  const [lookup, runLookup] = useCall(useCallback(() => recordLookup(SANDBOX_PLACE), []))
  const [created, runCreate] = useCall(
    useCallback(
      () =>
        createShare({
          placeLabel: 'Waterloo (sandbox)',
          lat: SANDBOX_PLACE.lat,
          lon: SANDBOX_PLACE.lon,
          pass: S2C_PASS,
          capture: S2C_CAPTURE,
          satName: 'Sentinel-2C',
        }),
      [],
    ),
  )
  const [shareId, setShareId] = useState('')
  const [share, runGet] = useCall(useCallback((id: string) => getShare(id), []))

  useEffect(() => {
    if (created.state === 'done' && created.value !== true) setShareId((created.value as CreatedShare).id)
  }, [created])

  const statsValue = stats.state === 'done' && stats.value !== true ? (stats.value as Stats) : null
  const createdValue = created.state === 'done' && created.value !== true ? (created.value as CreatedShare) : null
  const shareValue = share.state === 'done' && share.value !== true ? (share.value as Share) : null

  return (
    <main className="bkx">
      <style>{CSS}</style>
      <header className="bkx-head">
        <div className="bkx-mark">
          <span className="bkx-dot" aria-hidden />
          <Label>Overflight / backend</Label>
        </div>
        <h1 className="t-h1 bkx-title">
          Lookups, shares and <span className="t-serif">the card.</span>
        </h1>
        <p className="bkx-lede">
          Live calls to the Supabase RPCs through <code className="t-mono">src/lib/backend.ts</code>, as the browser makes them: publishable key, RPC
          only, no table access. Nothing here throws; an unavailable backend reads as an empty result.
        </p>
        <div className="bkx-tags">
          <Tag signal={configured}>{configured ? 'Configured' : 'Not configured'}</Tag>
          <Tag>{host ?? 'VITE_SUPABASE_URL unset'}</Tag>
          <Tag>Key · publishable</Tag>
        </div>
      </header>

      <div className="bkx-grid">
        {/* 01 — stats */}
        <section className="bkx-sec">
          <Rule index="01">Stats</Rule>
          <p className="bkx-note">
            <code className="t-mono">get_stats()</code>: totals, the busiest cells of the last 7 days (k ≥ 3 lookups) and a heatmap. Cached server-side
            for 60 s.
          </p>
          <div className="bkx-actions">
            <Button variant="primary" onClick={() => void runStats()} disabled={stats.state === 'busy'}>
              Get stats
            </Button>
          </div>
          <Status call={stats} empty="No response · backend unreachable or not configured" />
          <div className="bkx-readouts">
            <Readout label="Lookups" value={statsValue ? fmtInt(statsValue.total) : '—'} size="lg" />
            <Readout label="Last 24 h" value={statsValue ? fmtInt(statsValue.last24h) : '—'} size="lg" />
            <Readout label="Places" value={statsValue ? fmtInt(statsValue.places.length) : '—'} size="lg" />
          </div>
          {statsValue ? (
            <>
              {statsValue.cells.length ? <CellMap cells={statsValue.cells} /> : <p className="bkx-note t-faint">No lookups recorded yet, so there is no heatmap.</p>}
              {statsValue.places.length ? (
                <ol className="bkx-places">
                  {statsValue.places.map((p) => (
                    <li key={p.cell} className="t-mono">
                      <span>{p.label ?? '—'}</span>
                      <span className="t-faint">
                        {fmtLat(p.lat, 1)} {fmtLon(p.lon, 1)}
                      </span>
                      <span>{fmtInt(p.count)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="bkx-note t-faint">No cell has 3 or more lookups this week yet, so no places are listed.</p>
              )}
            </>
          ) : null}
          <Json value={statsValue ?? undefined} />
        </section>

        {/* 02 — lookup */}
        <section className="bkx-sec">
          <Rule index="02">Record lookup</Rule>
          <p className="bkx-note">
            <code className="t-mono">record_lookup()</code> for {fmtLat(SANDBOX_PLACE.lat)} {fmtLon(SANDBOX_PLACE.lon)}. Sent coarsened to the 0.1° cell
            (~10 km) with a city-level label; fire-and-forget.
          </p>
          <div className="bkx-actions">
            <Button onClick={() => void runLookup()} disabled={lookup.state === 'busy'}>
              Record lookup
            </Button>
          </div>
          <Status call={lookup} empty="No response" />
          <Json value={lookup.state === 'done' ? { sent: LOOKUP_SENT, result: 'void (204 No Content)' } : undefined} />

          {/* 03 — share */}
          <Rule index="03">Share</Rule>
          <p className="bkx-note">
            <code className="t-mono">create_share()</code> with a real Sentinel-2C pass and archive item. The server strips the track, rounds the place
            to 0.01° and the geometry to ~1 km, and rate-limits per area.
          </p>
          <div className="bkx-actions">
            <Button variant="primary" onClick={() => void runCreate()} disabled={created.state === 'busy'}>
              Create share
            </Button>
          </div>
          <Status call={created} empty="Not created · unreachable, invalid or rate-limited" />
          {createdValue ? (
            <dl className="bkx-kv t-mono">
              <dt className="t-label">ID</dt>
              <dd>{createdValue.id}</dd>
              <dt className="t-label">Link</dt>
              <dd>{createdValue.url}</dd>
              <dt className="t-label">Card</dt>
              <dd>{shareCardUrl(createdValue.id)}</dd>
            </dl>
          ) : null}

          <form
            className="bkx-get"
            onSubmit={(e) => {
              e.preventDefault()
              void runGet(shareId)
            }}
          >
            <label className="t-label" htmlFor="bkx-id">
              Share id
            </label>
            <input
              id="bkx-id"
              className="bkx-input t-mono"
              value={shareId}
              onChange={(e) => setShareId(e.target.value)}
              placeholder="8 characters"
              spellCheck={false}
              autoComplete="off"
              maxLength={16}
            />
            <Button type="submit" disabled={share.state === 'busy' || !shareId.trim()}>
              Get share
            </Button>
          </form>
          <Status call={share} empty="Not found · unknown id, or backend unreachable" />
          <Json value={shareValue ?? undefined} />
        </section>
      </div>

      {/* 04 — card */}
      <section className="bkx-sec bkx-card">
        <Rule index="04">Card</Rule>
        <p className="bkx-note">
          <code className="t-mono">/og-default.png</code>, the homepage card, baked from <code className="t-mono">api/og.tsx</code> with no parameters. Share
          cards are rendered by the same function per id; the Vite dev server does not run <code className="t-mono">api/</code>, so render them with{' '}
          <code className="t-mono">npx tsx scripts/backend-render-og.ts</code>.
        </p>
        <figure className="bkx-og">
          <img src="/og-default.png" width={1200} height={630} alt="Watched card: Something watched you this week." />
          <figcaption className="t-label">
            <span>1200 × 630 · PNG</span>
            <span>og:image · twitter:card summary_large_image</span>
          </figcaption>
        </figure>
      </section>
    </main>
  )
}

const CSS = `
.bkx { height: 100%; overflow-y: auto; overflow-x: hidden; padding: 48px var(--margin) 96px; }
.bkx-head { max-width: 760px; display: grid; gap: 18px; margin-bottom: 48px; }
.bkx-mark { display: flex; align-items: center; gap: 10px; }
.bkx-dot { width: 7px; height: 7px; background: var(--signal); }
.bkx-title { margin: 0; }
.bkx-lede { margin: 0; color: var(--bone-2); max-width: 62ch; }
.bkx-lede code, .bkx-note code { font-size: 12px; color: var(--bone); }
.bkx-tags { display: flex; flex-wrap: wrap; gap: 8px; }
.bkx-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 32px 48px; align-items: start; }
.bkx-sec { display: grid; gap: 16px; min-width: 0; }
.bkx-sec > .bkx-note { margin: 0; }
.bkx-note { font-size: 13px; color: var(--bone-2); max-width: 60ch; margin: 0; }
.bkx-actions { display: flex; gap: 12px; flex-wrap: wrap; }
.bkx-status { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); white-space: normal; }
.bkx-status-r { flex: none; }
.bkx-warn { color: var(--warn); }
.bkx-busy::after { content: ''; display: inline-block; width: 6px; height: 10px; margin-left: 8px; background: var(--signal); vertical-align: -1px; animation: bkx-blink 1s steps(1) infinite; }
@keyframes bkx-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .bkx-busy::after { animation: none; } }
.bkx-readouts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.bkx-readouts > * + * { border-left: 1px solid var(--line); padding-left: 16px; }
.bkx-json { margin: 0; padding: 14px 16px; max-height: 360px; overflow: auto; background: var(--ink-1); border: 1px solid var(--line); color: var(--bone-2); font-size: 11.5px; line-height: 1.55; white-space: pre; }
.bkx-map { margin: 0; display: grid; gap: 8px; }
.bkx-map canvas { display: block; width: 100%; aspect-ratio: 2 / 1; background: var(--ink-1); border: 1px solid var(--line); }
.bkx-map figcaption, .bkx-og figcaption { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.bkx-places { list-style: none; margin: 0; padding: 0; display: grid; }
.bkx-places li { display: grid; grid-template-columns: 1fr auto 56px; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.bkx-places li > :last-child { text-align: right; }
.bkx-kv { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 8px 16px; margin: 0; }
.bkx-kv dd { margin: 0; overflow-wrap: anywhere; color: var(--bone); }
.bkx-kv dt { align-self: center; }
.bkx-get { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px 16px; margin-top: 8px; }
.bkx-input { height: 44px; padding: 0 2px; background: transparent; border: 0; border-bottom: 1px solid var(--line-strong); color: var(--bone); font-size: 14px; letter-spacing: 0.08em; min-width: 0; border-radius: 0; }
.bkx-input:focus { outline: none; border-bottom: 2px solid var(--signal); }
.bkx-input::placeholder { color: var(--bone-3); }
.bkx-card { margin-top: 56px; }
.bkx-og { margin: 0; display: grid; gap: 10px; max-width: 1200px; }
.bkx-og img { width: 100%; height: auto; border: 1px solid var(--line); background: var(--ink-1); }
@media (max-width: 760px) {
  .bkx { padding: 32px var(--margin) 72px; }
  .bkx-grid { grid-template-columns: minmax(0, 1fr); }
  .bkx-get { grid-template-columns: minmax(0, 1fr) auto; }
  .bkx-get label { grid-column: 1 / -1; }
  .bkx-readouts > * + * { padding-left: 12px; }
}
`
