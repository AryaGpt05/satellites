/**
 * Engine sandbox: ?sandbox=engine
 *
 * Runs the real computeReport (real catalog, real SGP4 in workers, real STAC + GIBS archives) for
 * Waterloo and Tokyo, and shows timings, counts, geostationary watchers and every pass.
 * Never imported by production code.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildElementBuffer, computeReport, ELEMENT_STRIDE, getSatInfo, loadCatalog, type EngineReport } from '@/engine'
import type { Capture, Pass, Place, ProgressEvent } from '@/types'
import { Button, Glyph, Label, Readout, Rule, Tag, fmtInt, fmtLat, fmtLon, fmtNorad, fmtNum, fmtUtc, glyphForCategory } from '@/ui/system'

const PLACES: Place[] = [
  { label: 'Waterloo', sublabel: 'Ontario, Canada', lat: 43.4723, lon: -80.5449, countryCode: 'ca', source: 'demo' },
  { label: 'Tokyo', sublabel: 'Japan', lat: 35.6762, lon: 139.6503, countryCode: 'jp', source: 'demo' },
]

type Verdict = Pass['verdict']
const FILTERS: { key: 'all' | Verdict; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'imaged', label: 'Imaged' },
  { key: 'likely', label: 'Likely' },
  { key: 'could', label: 'Could' },
  { key: 'overhead', label: 'Overhead' },
]

interface RunLog {
  place: string
  firstMs: number
  totalMs: number
  catalogMs: number
  passesMs: number
  archiveMs: number
  weatherMs: number
  workers: number
  passes: number
  imaged: number
}

interface RunState {
  status: 'running' | 'done' | 'error'
  place: Place
  progress?: ProgressEvent
  /** The partial report (before GIBS verification) while running, then the final one. */
  report?: EngineReport
  message?: string
}

const ms = (v: number) => (v < 1000 ? `${Math.round(v)}` : fmtNum(v / 1000, 2))
const msUnit = (v: number) => (v < 1000 ? 'MS' : 'S')

export default function EngineSandbox() {
  const [run, setRun] = useState<RunState>({ status: 'running', place: PLACES[0] })
  const [log, setLog] = useState<RunLog[]>([])
  const [filter, setFilter] = useState<'all' | Verdict>('all')
  const ctrl = useRef<AbortController | null>(null)

  const start = useCallback((place: Place) => {
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    setRun({ status: 'running', place })
    computeReport(place, {
      signal: c.signal,
      onProgress: (progress) => {
        if (!c.signal.aborted) setRun((r) => ({ ...r, progress }))
      },
      onPartial: (report) => {
        if (!c.signal.aborted) setRun((r) => ({ ...r, report }))
      },
    }).then(
      (report) => {
        if (c.signal.aborted) return
        setRun({ status: 'done', place, report })
        const t = report.timings
        setLog((l) =>
          [
            {
              place: place.label,
              firstMs: t.firstResultMs,
              totalMs: t.totalMs,
              catalogMs: t.catalogMs,
              passesMs: t.passesMs,
              archiveMs: t.archiveMs,
              weatherMs: t.weatherMs,
              workers: t.workers,
              passes: report.counts.passes,
              imaged: report.counts.imaged,
            },
            ...l,
          ].slice(0, 8),
        )
      },
      (err: unknown) => {
        if (c.signal.aborted) return
        setRun({ status: 'error', place, message: err instanceof Error ? err.message : String(err) })
      },
    )
  }, [])

  useEffect(() => {
    start(PLACES[0])
    return () => ctrl.current?.abort()
  }, [start])

  const report = run.report
  const busy = run.status === 'running'

  return (
    <div className="esb">
      <style>{CSS}</style>
      <header className="esb-head">
        <div>
          <Label>Overflight · engine sandbox</Label>
          <h1 className="esb-title t-h2">
            Every pass over <span className="esb-place">{run.place.label}</span>, last 7 days
          </h1>
          <div className="esb-coords t-mono">
            {fmtLat(run.place.lat)} {fmtLon(run.place.lon)}
          </div>
        </div>
        <div className="esb-actions" role="group" aria-label="Place">
          {PLACES.map((p) => (
            <Button
              key={p.label}
              size="sm"
              variant={run.place.label === p.label ? 'primary' : 'secondary'}
              aria-pressed={run.place.label === p.label}
              disabled={busy}
              onClick={() => start(p)}
            >
              {p.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => start(run.place)}>
            Re-run
          </Button>
        </div>
      </header>

      <Rule index="01">Run</Rule>
      {busy ? <ProgressReadout progress={run.progress} /> : null}
      {run.status === 'error' ? (
        <p className="esb-error t-mono">
          <Label>Error</Label> {run.message ?? '—'}
        </p>
      ) : null}
      {report ? <Timings report={report} /> : <Skeleton rows={1} />}

      <Rule index="02">Counts</Rule>
      {report ? <Counts report={report} /> : <Skeleton rows={1} />}

      {report?.notes.length ? (
        <ul className="esb-notes t-mono">
          {report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      <Rule index="03">Geostationary</Rule>
      {report ? <GeoTable report={report} /> : <Skeleton rows={3} />}

      <Rule index="04">Images</Rule>
      {report ? <Captures report={report} /> : <Skeleton rows={2} />}

      <Rule index="05">Passes</Rule>
      <div className="esb-filters" role="tablist" aria-label="Filter passes">
        {FILTERS.map((f) => {
          const n = report ? (f.key === 'all' ? report.counts.passes : report.counts[f.key]) : undefined
          return (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={`esb-filter t-label${filter === f.key ? ' is-on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label} <span className="esb-filter-n">{n === undefined ? '—' : fmtInt(n)}</span>
            </button>
          )
        })}
      </div>
      {report ? <PassTable report={report} filter={filter} /> : <Skeleton rows={8} />}

      <Rule index="06">Run log</Rule>
      <RunLogTable log={log} />
      <CatalogFooter />
    </div>
  )
}

function ProgressReadout({ progress }: { progress?: ProgressEvent }) {
  const f = progress?.fraction
  return (
    <div className="esb-progress" aria-live="polite">
      <div className="esb-progress-msg t-mono">
        <span className="esb-stage">{progress?.stage ?? 'catalog'}</span>
        <span>{progress?.message ?? 'STARTING'}</span>
        <span className="esb-progress-pct">{f === undefined ? '—' : `${Math.round(f * 100)}%`}</span>
      </div>
      <div className="esb-bar" aria-hidden>
        <div className="esb-bar-fill" style={{ transform: `scaleX(${f ?? 0})` }} />
      </div>
    </div>
  )
}

function Timings({ report }: { report: EngineReport }) {
  const t = report.timings
  const pending = report.partial
  return (
    <div className="esb-grid">
      <Readout size="lg" label="First result" value={ms(t.firstResultMs)} unit={msUnit(t.firstResultMs)} />
      <Readout size="lg" label="Total" value={pending ? '—' : ms(t.totalMs)} unit={pending ? undefined : msUnit(t.totalMs)} />
      <Readout label="Pass search" value={ms(t.passesMs)} unit={msUnit(t.passesMs)} />
      <Readout label="STAC archive" value={ms(t.archiveMs)} unit={msUnit(t.archiveMs)} />
      <Readout label="GIBS mosaics" value={pending ? 'VERIFYING' : ms(t.weatherMs)} unit={pending ? undefined : msUnit(t.weatherMs)} />
      <Readout label="Workers" value={t.workers || 'MAIN'} />
    </div>
  )
}

function Counts({ report }: { report: EngineReport }) {
  const c = report.counts
  return (
    <div className="esb-grid">
      <Readout label="Satellites checked" value={fmtInt(c.satellitesConsidered)} />
      <Readout label="Passes" value={fmtInt(c.passes)} />
      <Readout label={<span className="esb-signal">Imaged</span>} value={<span className="esb-signal">{fmtInt(c.imaged)}</span>} />
      <Readout label="Likely" value={fmtInt(c.likely)} />
      <Readout label="Could" value={fmtInt(c.could)} />
      <Readout label="Overhead" value={fmtInt(c.overhead)} />
    </div>
  )
}

function GeoTable({ report }: { report: EngineReport }) {
  if (!report.geo.length) return <p className="esb-empty t-mono">No operational geostationary imager stands 5° above this horizon.</p>
  return (
    <div className="esb-scroll">
      <table className="esb-table t-mono">
        <thead>
          <tr>
            <th>Satellite</th>
            <th>Operator</th>
            <th className="num">Sub-lon</th>
            <th className="num">Elev</th>
            <th className="num">Cadence</th>
            <th className="num">Images</th>
            <th>GIBS</th>
          </tr>
        </thead>
        <tbody>
          {report.geo.map((g) => (
            <tr key={g.norad}>
              <td>
                <span className="esb-sat">
                  <Glyph name="weather-geo" size={12} />
                  {g.name}
                </span>
              </td>
              <td className="dim">{g.operator}</td>
              <td className="num">{fmtLon(g.subLon, 1)}</td>
              <td className="num">
                {fmtNum(g.elevationDeg, 1)}
                <span className="u">°</span>
              </td>
              <td className="num">
                {g.cadenceMin}
                <span className="u">MIN</span>
              </td>
              <td className="num">{fmtInt(g.imagesInWindow)}</td>
              <td className="dim">{g.gibs ? g.gibs.layer : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Captures({ report }: { report: EngineReport }) {
  const byId = useMemo(() => new Map(report.passes.filter((p) => p.captureId).map((p) => [p.captureId!, p])), [report])
  if (!report.captures.length) return <p className="esb-empty t-mono">No archive image of this place in the window.</p>
  return (
    <div className="esb-captures">
      {report.captures.map((c) => (
        <CaptureCard key={c.id} capture={c} pass={byId.get(c.id)} />
      ))}
    </div>
  )
}

function CaptureCard({ capture, pass }: { capture: Capture; pass?: Pass }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const name = pass ? getSatInfo(pass.norad)?.displayName : capture.platform
  const src = capture.cropUrl({ halfSizeKm: capture.provider === 'gibs' ? 60 : 4, px: 256 })
  return (
    <figure className="esb-cap">
      <div className={`esb-cap-img is-${state}`}>
        <img
          src={src}
          alt={`${name} image of the place`}
          loading="lazy"
          onLoad={() => setState('ready')}
          onError={() => setState('error')}
        />
        {state !== 'ready' ? <span className="esb-cap-state t-label">{state === 'loading' ? 'Loading' : 'Unavailable'}</span> : null}
      </div>
      <figcaption className="t-mono">
        <span className="esb-sat">
          <Glyph name="imaged" size={10} color="var(--signal)" />
          {name}
        </span>
        <span className="dim">{fmtUtc(pass?.tClosest ?? capture.datetime, false)}Z</span>
        <span className="dim">
          {capture.cloudCoverPct === undefined ? '—' : `${Math.round(capture.cloudCoverPct)}% CLOUD`} · {capture.gsdM} M
        </span>
      </figcaption>
    </figure>
  )
}

const ROW_LIMIT = 400

function PassTable({ report, filter }: { report: EngineReport; filter: 'all' | Verdict }) {
  const rows = useMemo(() => {
    const list = filter === 'all' ? report.passes : report.passes.filter((p) => p.verdict === filter)
    return [...list].sort((a, b) => b.tClosest - a.tClosest)
  }, [report, filter])
  if (!rows.length) return <p className="esb-empty t-mono">No passes in this class.</p>
  return (
    <>
      <div className="esb-scroll esb-scroll-tall">
        <table className="esb-table t-mono">
          <thead>
            <tr>
              <th>Closest, UTC</th>
              <th>Satellite</th>
              <th>Verdict</th>
              <th className="num">Off-nadir</th>
              <th className="num">Ground</th>
              <th className="num">Sun</th>
              <th className="num">Alt</th>
              <th className="num">Dir</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROW_LIMIT).map((p) => {
              const info = getSatInfo(p.norad)
              const imaged = p.verdict === 'imaged'
              return (
                <tr key={p.id} className={imaged ? 'is-imaged' : undefined}>
                  <td>{fmtUtc(p.tClosest)}</td>
                  <td>
                    <span className="esb-sat" title={`NORAD ${fmtNorad(p.norad)}`}>
                      <Glyph name={glyphForCategory(info?.category ?? 'other', imaged)} size={12} color={imaged ? 'var(--signal)' : undefined} />
                      {info?.displayName ?? p.norad}
                    </span>
                  </td>
                  <td className={imaged ? 'esb-signal' : 'dim'}>{p.verdict}</td>
                  <td className="num">
                    {fmtNum(p.offNadirDeg, 1)}
                    <span className="u">°</span>
                  </td>
                  <td className="num">
                    {fmtInt(p.groundDistanceKm)}
                    <span className="u">KM</span>
                  </td>
                  <td className={`num${p.sunElevationDeg < 0 ? ' dim' : ''}`}>
                    {fmtNum(p.sunElevationDeg, 1)}
                    <span className="u">°</span>
                  </td>
                  <td className="num">
                    {fmtInt(p.altitudeKm)}
                    <span className="u">KM</span>
                  </td>
                  <td className="num dim">{p.node === 'ascending' ? 'N' : 'S'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length > ROW_LIMIT ? (
        <p className="esb-foot t-label">
          Showing the newest {fmtInt(ROW_LIMIT)} of {fmtInt(rows.length)}
        </p>
      ) : null}
    </>
  )
}

function RunLogTable({ log }: { log: RunLog[] }) {
  if (!log.length) return <p className="esb-empty t-mono">—</p>
  const cell = (v: number) => (
    <td className="num">
      {ms(v)}
      <span className="u">{msUnit(v)}</span>
    </td>
  )
  return (
    <div className="esb-scroll">
      <table className="esb-table t-mono">
        <thead>
          <tr>
            <th>Place</th>
            <th className="num">First</th>
            <th className="num">Total</th>
            <th className="num">Catalog</th>
            <th className="num">Passes</th>
            <th className="num">STAC</th>
            <th className="num">GIBS</th>
            <th className="num">Workers</th>
            <th className="num">Found</th>
            <th className="num">Imaged</th>
          </tr>
        </thead>
        <tbody>
          {log.map((r, i) => (
            <tr key={i}>
              <td>{r.place}</td>
              {cell(r.firstMs)}
              {cell(r.totalMs)}
              {cell(r.catalogMs)}
              {cell(r.passesMs)}
              {cell(r.archiveMs)}
              {cell(r.weatherMs)}
              <td className="num">{r.workers || 'MAIN'}</td>
              <td className="num">{fmtInt(r.passes)}</td>
              <td className="num esb-signal">{fmtInt(r.imaged)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CatalogFooter() {
  const [line, setLine] = useState('—')
  const [gpu, setGpu] = useState('—')
  useEffect(() => {
    loadCatalog().then(
      (c) => {
        setLine(`${fmtInt(c.sats.length)} OBJECTS · TLE EPOCH ${fmtUtc(Date.parse(c.fetchedAt), false)}Z · ${c.source.toUpperCase()}`)
        const t0 = performance.now()
        const buf = buildElementBuffer(c)
        setGpu(`${fmtInt(buf.count)} × ${ELEMENT_STRIDE} FLOATS · BUILT IN ${Math.round(performance.now() - t0)} MS`)
      },
      () => setLine('CATALOG UNAVAILABLE'),
    )
  }, [])
  return (
    <footer className="esb-footer">
      <span className="esb-footer-row">
        <Tag>Catalog</Tag>
        <span className="t-label">{line}</span>
      </span>
      <span className="esb-footer-row">
        <Tag>GPU buffer</Tag>
        <span className="t-label">{gpu}</span>
      </span>
    </footer>
  )
}

/** Placeholder while the report is computing: empty hairline rows, no shimmer (DESIGN.md §1). */
function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="esb-skeleton" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="esb-skeleton-row t-label">
          {i === 0 ? 'Awaiting report' : '—'}
        </div>
      ))}
    </div>
  )
}

const CSS = `
.esb { position: fixed; inset: 0; overflow-y: auto; overflow-x: hidden; background: var(--ink-0); color: var(--bone);
  padding: var(--margin); display: flex; flex-direction: column; gap: var(--s-5); }
.esb > * { max-width: 1180px; width: 100%; margin-inline: auto; flex-shrink: 0; }
.esb-head { display: flex; justify-content: space-between; align-items: flex-end; gap: var(--s-5); flex-wrap: wrap; padding-top: var(--s-4); }
.esb-title { margin: var(--s-3) 0 var(--s-2); font-family: var(--font-sans); }
.esb-place { color: var(--bone); }
.esb-coords { color: var(--bone-3); }
.esb-actions { display: flex; gap: var(--s-2); flex-wrap: wrap; }
.esb-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--s-5) var(--gutter); }
.esb-signal, .esb-table .esb-signal { color: var(--signal); }
.esb-progress { display: flex; flex-direction: column; gap: var(--s-2); }
.esb-progress-msg { display: flex; gap: var(--s-3); text-transform: uppercase; color: var(--bone-2); min-width: 0; }
.esb-progress-msg > span:nth-child(2) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.esb-stage { color: var(--bone-3); min-width: 9ch; }
.esb-progress-pct { color: var(--bone); }
.esb-bar { height: 1px; background: var(--line); overflow: hidden; }
.esb-bar-fill { height: 1px; background: var(--signal); transform-origin: left; transition: transform var(--d-sm) var(--ease-out); }
.esb-error { color: var(--warn); display: flex; gap: var(--s-3); }
.esb-notes { margin: 0; padding: 0; list-style: none; color: var(--bone-3); font-size: 11px; display: grid; gap: var(--s-1); }
.esb-notes li::before { content: '※ '; color: var(--warn); }
.esb-empty { color: var(--bone-3); margin: 0; }
.esb-scroll { overflow-x: auto; border-top: 1px solid var(--line); -webkit-overflow-scrolling: touch; }
.esb-scroll-tall { max-height: 560px; overflow-y: auto; }
.esb-table { width: 100%; border-collapse: collapse; font-size: 11.5px; white-space: nowrap; }
.esb-table th { position: sticky; top: 0; background: var(--ink-0); text-align: left; font-weight: 400; font-size: var(--fs-label);
  letter-spacing: var(--track-label); text-transform: uppercase; color: var(--bone-3); padding: 10px 14px 8px 0; border-bottom: 1px solid var(--line); }
.esb-table td { padding: 7px 14px 7px 0; border-bottom: 1px solid var(--line); color: var(--bone); }
.esb-table tbody tr:hover td { background: var(--ink-1); }
.esb-table .num { text-align: right; }
.esb-table .dim { color: var(--bone-3); }
.esb-table .u { margin-left: 0.35em; font-size: 0.82em; color: var(--bone-3); }
.esb-table tr.is-imaged td:first-child { box-shadow: inset 2px 0 0 var(--signal); padding-left: 8px; }
.esb-sat { display: inline-flex; align-items: center; gap: 8px; }
.esb-filters { display: flex; gap: var(--s-4); flex-wrap: wrap; margin-top: calc(-1 * var(--s-2)); }
.esb-filter { padding: 4px 0; border-bottom: 1px solid transparent; color: var(--bone-3); transition: color var(--d-hover) var(--ease-out); }
.esb-filter:hover { color: var(--bone); }
.esb-filter.is-on { color: var(--bone); border-bottom-color: var(--signal); }
.esb-filter-n { color: var(--bone-2); margin-left: 4px; }
.esb-foot { margin-block: 0; }
.esb-captures { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: var(--gutter); }
.esb-cap { margin: 0; display: flex; flex-direction: column; gap: var(--s-2); min-width: 0; }
.esb-cap-img { position: relative; aspect-ratio: 1; background: var(--ink-1); border: 1px solid var(--line); overflow: hidden; }
.esb-cap-img img { width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity var(--d-md) var(--ease-out); }
.esb-cap-img.is-ready img { opacity: 1; }
.esb-cap-state { position: absolute; inset: 0; display: grid; place-items: center; }
.esb-cap figcaption { display: flex; flex-direction: column; gap: 2px; font-size: 11px; min-width: 0; }
.esb-cap figcaption > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.esb-cap .dim { color: var(--bone-3); }
.esb-skeleton { display: grid; border-top: 1px solid var(--line); }
.esb-skeleton-row { height: 30px; display: flex; align-items: center; border-bottom: 1px solid var(--line); color: var(--bone-4); }
.esb-footer { display: flex; gap: var(--s-3) var(--s-6); padding: var(--s-5) 0 var(--s-6); border-top: 1px solid var(--line); flex-wrap: wrap; }
.esb-footer-row { display: flex; gap: var(--s-3); align-items: center; min-width: 0; }
.esb-footer .t-label { white-space: normal; }
@media (max-width: 760px) {
  .esb { gap: var(--s-4); }
  .esb-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .esb-head { align-items: flex-start; }
  .esb-captures { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4); }
}
`
