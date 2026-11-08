/**
 * Imagery module sandbox: ?sandbox=imagery
 *
 * Everything shown is fetched live from the public archives through src/imagery. The only
 * fixtures are the weather-satellite *passes* in section 03 (pass prediction belongs to the
 * engine); the images they resolve to are real and pixel-verified.
 * Never imported by production code.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { sunElevationDeg } from '@/lib/geo'
import type { Capture, LatLon, Pass, Place } from '@/types'
import { Button, Glyph, Label, Readout, Rule, Tag, fmtAgo, fmtInt, fmtLat, fmtLocal, fmtLon, fmtNorad, fmtNum, fmtUtc } from '@/ui/system'
import {
  geoImageUrl,
  isAbortError,
  latestGeoImage,
  locateMe,
  preloadImage,
  reversePlace,
  searchCapturesDetailed,
  searchPlaces,
  spotCloud,
  timeZoneAt,
  weatherCaptures,
  type CaptureSearchResult,
  type GibsCollection,
  type SpotCloud,
} from '@/imagery'
import { GIBS_LAYERS, weatherCandidates } from '@/imagery/gibs'

const WATERLOO: Place = { lat: 43.4723, lon: -80.5449, label: 'Waterloo', sublabel: 'Ontario, Canada', countryCode: 'ca', source: 'demo' }
const DAY = 86_400_000
const WINDOW_DAYS = 14

// ── Small building blocks ──────────────────────────────────────────────────────────────────

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T; ms: number } | { state: 'error'; message: string }

/** Run an abortable async job whenever `deps` change; abort the previous one. */
function useJob<T>(job: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Load<T> {
  const [s, set] = useState<Load<T>>({ state: 'loading' })
  useEffect(() => {
    const ctrl = new AbortController()
    const t0 = performance.now()
    set({ state: 'loading' })
    job(ctrl.signal).then(
      (value) => set({ state: 'ready', value, ms: performance.now() - t0 }),
      (err: unknown) => {
        if (!isAbortError(err) && !ctrl.signal.aborted) set({ state: 'error', message: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => ctrl.abort()
  }, deps)
  return s
}

/** Decoded-before-shown image with instrument-style loading / error states. */
function Picture({ src, alt, caption }: { src: string; alt: string; caption?: ReactNode }) {
  const [st, setSt] = useState<'loading' | 'ready' | 'error'>('loading')
  const [ms, setMs] = useState(0)
  useEffect(() => {
    const ctrl = new AbortController()
    const t0 = performance.now()
    setSt('loading')
    preloadImage(src, { signal: ctrl.signal }).then(
      () => {
        setMs(performance.now() - t0)
        setSt('ready')
      },
      () => !ctrl.signal.aborted && setSt('error'),
    )
    return () => ctrl.abort()
  }, [src])
  return (
    <figure className="imx-pic">
      <div className="imx-frame" data-state={st}>
        {st === 'ready' ? <img src={src} alt={alt} crossOrigin="anonymous" decoding="async" /> : null}
        {st === 'loading' ? (
          <div className="imx-wait">
            <span className="t-label">Rendering</span>
            <span className="imx-bar" aria-hidden />
          </div>
        ) : null}
        {st === 'error' ? (
          <div className="imx-wait">
            <span className="t-label">Image unavailable</span>
            <a className="t-label imx-link" href={src} target="_blank" rel="noreferrer">
              Open URL <Glyph name="arrow-up-right" size={10} />
            </a>
          </div>
        ) : null}
      </div>
      <figcaption className="imx-cap t-label">
        {caption}
        {st === 'ready' ? <span className="imx-cap-r">{fmtInt(ms)} MS</span> : null}
      </figcaption>
    </figure>
  )
}

const VERDICT_COPY: Record<SpotCloud, string> = { clear: 'Clear', cloud: 'Cloud', shadow: 'Shadow', unknown: '—' }

function SpotVerdict({ capture, place }: { capture: Capture; place: LatLon }) {
  const job = useJob((s) => spotCloud(capture, place, s), [capture.id, place.lat, place.lon])
  if (job.state === 'loading') return <span className="t-faint">…</span>
  if (job.state === 'error') return <span className="t-faint">—</span>
  const v = job.value
  return <span className={`imx-verdict imx-verdict-${v}`}>{VERDICT_COPY[v]}</span>
}

const PLATFORM_NAME: Record<string, string> = {
  'sentinel-2a': 'Sentinel-2A',
  'sentinel-2b': 'Sentinel-2B',
  'sentinel-2c': 'Sentinel-2C',
  'landsat-8': 'Landsat 8',
  'landsat-9': 'Landsat 9',
  'noaa-20': 'NOAA-20',
  'noaa-21': 'NOAA-21',
  'suomi-npp': 'Suomi NPP',
  terra: 'Terra',
  aqua: 'Aqua',
}
const platformName = (p: string) => PLATFORM_NAME[p] ?? p.toUpperCase()

function CaptureCard({ capture, place, tz }: { capture: Capture; place: Place; tz: string }) {
  const src = useMemo(() => capture.cropUrl({ halfSizeKm: 3, px: 768 }), [capture])
  return (
    <article className="imx-card">
      <Picture
        src={src}
        alt={`${platformName(capture.platform)} image of ${place.label}, ${fmtUtc(capture.datetime, false)} UTC`}
        caption={<span>6 × 6 KM · 768 PX</span>}
      />
      <header className="imx-card-h">
        <span className="imx-name">
          <Glyph name="imaged" size={12} color="var(--signal)" />
          {platformName(capture.platform)}
        </span>
        <span className="t-label">NORAD {capture.norad ? fmtNorad(capture.norad) : '—'}</span>
      </header>
      <div className="imx-when t-mono">
        {fmtUtc(capture.datetime)} <span className="t-faint">UTC</span>
        <span className="t-faint imx-when-r">
          {fmtLocal(capture.datetime, tz)} local · {fmtAgo(capture.datetime)}
        </span>
      </div>
      <div className="imx-metrics">
        <Readout label="Scene cloud" value={capture.cloudCoverPct !== undefined ? fmtNum(capture.cloudCoverPct, 1) : '—'} unit={capture.cloudCoverPct !== undefined ? '%' : undefined} />
        <Readout label="At the spot" value={<SpotVerdict capture={capture} place={place} />} />
        <Readout label="Sun" value={capture.sunElevationDeg !== undefined ? fmtNum(capture.sunElevationDeg, 1) : '—'} unit="°" />
        <Readout label="GSD" value={capture.gsdM} unit="M" />
      </div>
      <footer className="imx-card-f">
        <Tag>{capture.provider === 'planetary-computer' ? 'Planetary Computer' : capture.provider === 'earth-search' ? 'Earth Search' : 'NASA GIBS'}</Tag>
        <span className="imx-links">
          {capture.previewUrl ? (
            <a className="t-label imx-link" href={capture.previewUrl} target="_blank" rel="noreferrer">
              Scene <Glyph name="arrow-up-right" size={10} />
            </a>
          ) : null}
          {capture.sourceUrl ? (
            <a className="t-label imx-link" href={capture.sourceUrl} target="_blank" rel="noreferrer">
              STAC <Glyph name="arrow-up-right" size={10} />
            </a>
          ) : null}
        </span>
      </footer>
    </article>
  )
}

// ── Sections ───────────────────────────────────────────────────────────────────────────────

function Geocoder({ onPick, active }: { onPick: (p: Place) => void; active: Place }) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<Load<Place[]> | null>(null)
  const [locating, setLocating] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== input.current) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (q.trim().length < 2) {
      setRes(null)
      return
    }
    const ctrl = new AbortController()
    const t0 = performance.now()
    const id = window.setTimeout(() => {
      setRes({ state: 'loading' })
      searchPlaces(q, ctrl.signal).then(
        (value) => setRes({ state: 'ready', value, ms: performance.now() - t0 }),
        (err: unknown) => !isAbortError(err) && setRes({ state: 'error', message: 'Search is unavailable right now.' }),
      )
    }, 220)
    return () => {
      window.clearTimeout(id)
      ctrl.abort()
    }
  }, [q])

  const locate = async () => {
    setLocating('Locating')
    try {
      const pos = await locateMe()
      setLocating('Naming')
      onPick(await reversePlace(pos.lat, pos.lon))
      setLocating(null)
    } catch (err) {
      setLocating(err instanceof Error ? err.message : 'Location unavailable.')
    }
  }

  return (
    <section className="imx-section">
      <Rule className="imx-rule" index="01">Geocoder · Photon</Rule>
      <div className="imx-search">
        <label className="imx-field">
          <Glyph name="search" size={14} color="var(--bone-3)" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a place, or type coordinates"
            aria-label="Search a place"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="t-label imx-kbd">/</span>
        </label>
        <Button size="sm" onClick={locate}>
          <Glyph name="locate" size={12} /> Locate me
        </Button>
      </div>
      {locating ? <p className="imx-note t-mono">{locating}</p> : null}
      {res?.state === 'loading' ? <p className="imx-note t-label">Searching…</p> : null}
      {res?.state === 'error' ? <p className="imx-note t-mono">{res.message}</p> : null}
      {res?.state === 'ready' && res.value.length === 0 ? <p className="imx-note t-mono">No place matches “{q.trim()}”.</p> : null}
      {res?.state === 'ready' && res.value.length > 0 ? (
        <ol className="imx-results">
          {res.value.map((p) => {
            const on = Math.abs(p.lat - active.lat) < 1e-6 && Math.abs(p.lon - active.lon) < 1e-6
            return (
              <li key={`${p.lat},${p.lon}`}>
                <button className="imx-result" data-on={on || undefined} onClick={() => onPick(p)}>
                  <span className="imx-result-l">
                    <span className="imx-result-name">{p.label}</span>
                    <span className="imx-result-sub">{p.sublabel ?? '—'}</span>
                  </span>
                  <span className="t-mono t-faint imx-result-r">
                    {fmtLat(p.lat, 3)} {fmtLon(p.lon, 3)}
                    <span className="imx-hide-sm"> · {timeZoneAt(p.lat, p.lon)}</span>
                    {p.countryCode ? <span className="imx-hide-sm"> · {p.countryCode.toUpperCase()}</span> : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      ) : null}
      {res?.state === 'ready' ? <p className="imx-foot t-label">{fmtInt(res.ms)} MS · OPENSTREETMAP CONTRIBUTORS</p> : null}
    </section>
  )
}

function Captures({ place, now, tz }: { place: Place; now: number; tz: string }) {
  const job = useJob<CaptureSearchResult>((s) => searchCapturesDetailed(place, now - WINDOW_DAYS * DAY, now, s), [place.lat, place.lon, now])
  const caps = job.state === 'ready' ? job.value.captures : []
  const s2 = caps.filter((c) => c.collection === 'sentinel-2-l2a').length
  return (
    <section className="imx-section">
      <Rule className="imx-rule" index="02">Captures · Sentinel-2 + Landsat · last {WINDOW_DAYS} days</Rule>
      <div className="imx-readouts">
        <Readout label="Scenes" value={job.state === 'ready' ? caps.length : '—'} />
        <Readout label="Sentinel-2" value={job.state === 'ready' ? s2 : '—'} />
        <Readout label="Landsat" value={job.state === 'ready' ? caps.length - s2 : '—'} />
        <Readout label="Search" value={job.state === 'ready' ? fmtInt(job.ms) : '—'} unit="MS" />
        <Readout label="Window" value={`${fmtUtc(now - WINDOW_DAYS * DAY, false).slice(0, 10)} → ${fmtUtc(now, false).slice(0, 10)}`} />
      </div>
      {job.state === 'loading' ? (
        <div className="imx-status">
          <span className="t-label">Searching Planetary Computer</span>
          <span className="imx-bar" aria-hidden />
        </div>
      ) : null}
      {job.state === 'error' ? <p className="imx-note t-mono">{job.message}</p> : null}
      {job.state === 'ready' && job.value.degraded.length > 0 ? (
        <ul className="imx-degraded">
          {job.value.degraded.map((d) => (
            <li key={d} className="t-mono">
              {d}
            </li>
          ))}
        </ul>
      ) : null}
      {job.state === 'ready' && caps.length === 0 ? (
        <p className="imx-note t-mono">No Sentinel-2 or Landsat scene covers this place in the last {WINDOW_DAYS} days.</p>
      ) : null}
      {caps.length > 0 ? (
        <div className="imx-grid">
          {caps.map((c) => (
            <CaptureCard key={c.id} capture={c} place={place} tz={tz} />
          ))}
        </div>
      ) : null}
      <p className="imx-foot t-label">
        Crops rendered by Planetary Computer from the archived scene · “At the spot” reads the scene classification under the exact point
      </p>
    </section>
  )
}

/**
 * SANDBOX FIXTURE: approximate daytime overpasses of the GIBS-served polar imagers for the last
 * two UTC days (ascending ~13:30 local solar time; Terra descending ~10:30). The engine
 * computes the real ones; these only exercise weatherCaptures + its no-data probe.
 */
function fixturePasses(place: LatLon, now: number): Pass[] {
  const sats: [number, number][] = [
    [43013, 13.5],
    [54234, 13.4],
    [37849, 13.6],
    [27424, 13.5],
    [25994, 10.5],
  ]
  const out: Pass[] = []
  for (let d = 1; d <= 2; d++) {
    const day = Math.floor(now / DAY) * DAY - d * DAY
    for (const [norad, lst] of sats) {
      const t = Math.round(day + ((lst - place.lon / 15 + 24) % 24) * 3_600_000)
      out.push({
        id: `fixture-${norad}-${d}`,
        norad,
        tClosest: t,
        tStart: t - 90_000,
        tEnd: t + 90_000,
        groundDistanceKm: 150,
        offNadirDeg: 10,
        elevationDeg: 75,
        azimuthDeg: 270,
        altitudeKm: 830,
        groundSpeedKmS: 6.6,
        headingDeg: norad === 25994 ? 195 : 345,
        node: norad === 25994 ? 'descending' : 'ascending',
        sunElevationDeg: sunElevationDeg(place.lat, place.lon, t),
        inSwath: true,
        inFieldOfRegard: true,
        verdict: 'likely',
        track: [],
      })
    }
  }
  return out
}

function Weather({ place, now }: { place: Place; now: number }) {
  const passes = useMemo(() => fixturePasses(place, now), [place, now])
  const candidates = useMemo(() => weatherCandidates(place, passes), [place, passes])
  const job = useJob((s) => weatherCaptures(place, passes, s), [passes])
  const kept = job.state === 'ready' ? new Set(job.value.map((c) => c.id)) : null
  const hero = job.state === 'ready' ? (job.value.find((c) => c.collection.startsWith('gibs-viirs')) ?? job.value[0]) : undefined
  return (
    <section className="imx-section">
      <Rule className="imx-rule" index="03">Weather · NASA GIBS daily VIIRS / MODIS</Rule>
      <div className="imx-split">
        <div>
          {hero ? (
            <Picture
              src={hero.cropUrl({ halfSizeKm: 150, px: 768 })}
              alt={`${platformName(hero.platform)} daily true-colour image around ${place.label}`}
              caption={
                <span>
                  {platformName(hero.platform)} · {fmtUtc(hero.datetime, false).slice(0, 10)} · 300 × 300 KM
                </span>
              }
            />
          ) : (
            <div className="imx-frame imx-frame-empty">
              <div className="imx-wait">
                <span className="t-label">{job.state === 'loading' ? 'Probing GIBS' : job.state === 'error' ? job.message : 'No daily image with data'}</span>
                {job.state === 'loading' ? <span className="imx-bar" aria-hidden /> : null}
              </div>
            </div>
          )}
        </div>
        <div>
          <Label as="div" className="imx-sub">
            Candidates · {candidates.length} · fixture passes, real images
          </Label>
          <ol className="imx-rows">
            {candidates.map((c) => (
              <li key={c.id} className="imx-row t-mono">
                <span>{platformName(c.platform)}</span>
                <span className="t-faint">{fmtUtc(c.datetime, false)}</span>
                <span>{GIBS_LAYERS[c.collection as GibsCollection]?.gsdM ?? c.gsdM} M</span>
                <span className={kept ? (kept.has(c.id) ? undefined : 'imx-dropped') : 't-faint'}>
                  {kept ? (kept.has(c.id) ? 'Data' : 'No data · dropped') : 'Probing'}
                </span>
              </li>
            ))}
          </ol>
          <p className="imx-foot t-label">Each candidate is verified with a 24 × 24 px probe; black or empty frames are dropped</p>
        </div>
      </div>
    </section>
  )
}

/** Which GIBS geostationary layer sees this longitude best (GOES-East −75.2°, GOES-West −137.2°, Himawari 140.7°). */
function geoFor(lon: number): GibsCollection | null {
  const subs: [GibsCollection, number][] = [
    ['gibs-goes-east', -75.2],
    ['gibs-goes-west', -137.2],
    ['gibs-himawari', 140.7],
  ]
  const d = (a: number) => Math.abs(((((lon - a) % 360) + 540) % 360) - 180)
  const best = subs.sort((a, b) => d(a[1]) - d(b[1]))[0]
  return d(best[1]) <= 65 ? best[0] : null
}
const GEO_NAME: Partial<Record<GibsCollection, string>> = {
  'gibs-goes-east': 'GOES-East · GeoColor',
  'gibs-goes-west': 'GOES-West · GeoColor',
  'gibs-himawari': 'Himawari · Band 3 visible',
}

function GeoFrame({ collection, place, now }: { collection: GibsCollection; place: Place; now: number }) {
  const opts = { halfSizeKm: 700, px: 768 }
  const job = useJob((s) => latestGeoImage(collection, place, opts, { signal: s, now }), [collection, place.lat, place.lon, now])
  const found = job.state === 'ready' ? job.value : null
  const src = found?.url ?? (job.state !== 'loading' ? geoImageUrl(collection, place, now, opts) : null)
  return (
    <div>
      {src ? (
        <Picture
          src={src}
          alt={`${GEO_NAME[collection]} frame around ${place.label}`}
          caption={
            <span>
              {GEO_NAME[collection]} · <span className="imx-nw">{found ? `${fmtUtc(found.time, false)} UTC` : 'held-back frame (unverified)'}</span>
              {found ? <span className="imx-nw"> · {fmtAgo(found.time, now)}</span> : null}
            </span>
          }
        />
      ) : (
        <div className="imx-frame imx-frame-empty">
          <div className="imx-wait">
            <span className="t-label">Finding newest frame</span>
            <span className="imx-bar" aria-hidden />
          </div>
        </div>
      )}
    </div>
  )
}

function Geostationary({ place, now }: { place: Place; now: number }) {
  const geo = geoFor(place.lon)
  const tokyo: Place = { lat: 35.6762, lon: 139.6503, label: 'Tokyo', source: 'demo' }
  return (
    <section className="imx-section">
      <Rule className="imx-rule" index="04">Geostationary · newest frame with data</Rule>
      <div className="imx-split imx-split-even">
        {geo ? <GeoFrame collection={geo} place={place} now={now} /> : <p className="imx-note t-mono">No GIBS geostationary layer covers {fmtLon(place.lon, 1)}.</p>}
        {geo !== 'gibs-himawari' ? <GeoFrame collection="gibs-himawari" place={tokyo} now={now} /> : null}
      </div>
      <p className="imx-foot t-label">Frames younger than 70 min are not reliably served by GIBS; the newest verified frame is shown</p>
    </section>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────────────────

export default function ImagerySandbox() {
  const [place, setPlace] = useState<Place>(WATERLOO)
  const [now] = useState(() => Date.now())
  const tz = useMemo(() => timeZoneAt(place.lat, place.lon), [place])
  return (
    <div className="imx">
      <style>{CSS}</style>
      <header className="imx-head">
        <div className="imx-head-row">
          <Label>Overflight / Sandbox / Imagery</Label>
          <Label className="imx-hide-sm">PC STAC · Earth Search · NASA GIBS · Photon</Label>
        </div>
        <h1 className="t-h1 imx-title">Imagery</h1>
        <p className="imx-lede">Every picture on this page is real, fetched live from public archives for one place.</p>
        <div className="imx-place">
          <span className="imx-place-name">
            <Glyph name="reticle" size={14} color="var(--signal)" />
            <span>
              {place.label}
              {place.sublabel ? <span className="t-dim">{`, ${place.sublabel}`}</span> : null}
            </span>
          </span>
          <span className="t-mono t-dim">
            {fmtLat(place.lat)} {fmtLon(place.lon)} · {tz}
          </span>
          {place !== WATERLOO ? (
            <Button size="sm" variant="ghost" onClick={() => setPlace(WATERLOO)}>
              Reset to Waterloo
            </Button>
          ) : null}
        </div>
      </header>
      <Geocoder onPick={setPlace} active={place} />
      <Captures place={place} now={now} tz={tz} />
      <Weather place={place} now={now} />
      <Geostationary place={place} now={now} />
    </div>
  )
}

const CSS = /* css */ `
.imx { height: 100%; overflow-y: auto; overflow-x: hidden; padding: 40px var(--margin) 96px; }
.imx > * { max-width: 1320px; margin-left: auto; margin-right: auto; }
.imx-head { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; padding-bottom: 32px; }
.imx-rule { white-space: normal; min-width: 0; }
.imx-head-row { display: flex; justify-content: space-between; gap: 16px; min-width: 0; }
.imx-title { margin: 8px 0 0; }
.imx-lede { margin: 0; color: var(--bone-2); max-width: 56ch; }
.imx-place { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; padding-top: 8px; border-top: 1px solid var(--line); }
.imx-place-name { display: inline-flex; align-items: center; gap: 8px; font-size: 15px; }
.imx-section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; padding: 28px 0 36px; }
.imx-search { display: flex; gap: 16px; align-items: end; }
.imx-field { flex: 1; display: flex; align-items: center; gap: 10px; height: 44px; border-bottom: 1px solid var(--line-strong); transition: border-color var(--d-hover) var(--ease-out), box-shadow var(--d-hover) var(--ease-out); }
.imx-field:focus-within { border-color: var(--bone); box-shadow: 0 1px 0 0 var(--bone); }
.imx-field input { flex: 1; min-width: 0; background: transparent; border: 0; outline: none; font-size: 17px; caret-color: var(--signal); }
.imx-field input::placeholder { color: var(--bone-3); }
.imx-kbd { border: 1px solid var(--line-strong); padding: 0 6px; }
.imx-results { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.imx-results li { border-bottom: 1px solid var(--line); }
.imx-result { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 4px; text-align: left; transition: background-color var(--d-hover) var(--ease-out); }
.imx-result:hover { background: var(--ink-2); }
.imx-result[data-on] .imx-result-name { color: var(--signal); }
.imx-result-l { display: grid; gap: 2px; min-width: 0; }
.imx-result-name { font-size: 15px; }
.imx-result-sub { font-size: 13px; color: var(--bone-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imx-result-r { white-space: nowrap; }
.imx-note { margin: 0; color: var(--bone-2); }
.imx-foot { margin: 0; white-space: normal; }
.imx-readouts { display: flex; flex-wrap: wrap; gap: 16px 40px; }
.imx-status { display: grid; gap: 10px; max-width: 360px; }
.imx-degraded { margin: 0; padding: 10px 12px; list-style: none; border: 1px solid var(--line-strong); border-left: 2px solid var(--warn); color: var(--bone-2); display: grid; gap: 4px; }
.imx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 32px 24px; }
.imx-card { display: grid; gap: 12px; align-content: start; }
.imx-card-h { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.imx-name { display: inline-flex; align-items: center; gap: 8px; font-stretch: 80%; font-weight: 540; font-size: 20px; letter-spacing: -0.01em; }
.imx-when { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; }
.imx-when-r { font-size: 11px; }
.imx-metrics { display: grid; grid-template-columns: repeat(4, auto); justify-content: space-between; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.imx-card-f { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.imx-links { display: inline-flex; gap: 16px; }
.imx-link { display: inline-flex; align-items: center; gap: 4px; color: var(--bone-2); text-decoration: none; }
.imx-link:hover { color: var(--signal); }
.imx-verdict-clear { color: var(--signal); }
.imx-verdict-cloud { color: var(--warn); }
.imx-verdict-shadow { color: var(--bone-2); }
.imx-verdict-unknown { color: var(--bone-3); }
.imx-pic { margin: 0; display: grid; gap: 8px; }
.imx-frame { position: relative; aspect-ratio: 1; background: var(--ink-1); outline: 1px solid var(--line); outline-offset: -1px; overflow: hidden; }
.imx-frame img { width: 100%; height: 100%; object-fit: cover; animation: imx-in var(--d-md) var(--ease-out); }
.imx-frame-empty { max-width: 100%; }
.imx-wait { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 12px; padding: 16px; text-align: center; }
.imx-wait .t-label { white-space: normal; }
.imx-cap { display: flex; justify-content: space-between; gap: 12px; white-space: normal; }
.imx-cap-r, .imx-nw { white-space: nowrap; }
.imx-bar { position: relative; display: block; width: 160px; max-width: 100%; height: 1px; background: var(--line-strong); overflow: hidden; }
.imx-bar::after { content: ''; position: absolute; inset: 0; width: 30%; background: var(--signal); animation: imx-scan 1.4s var(--ease-in-out) infinite; }
.imx-split { display: grid; grid-template-columns: minmax(0, 560px) minmax(0, 1fr); gap: 40px; align-items: start; }
.imx-split-even { grid-template-columns: repeat(2, minmax(0, 560px)); }
.imx-sub { margin-bottom: 10px; white-space: normal; }
.imx-rows { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.imx-row { display: grid; grid-template-columns: 1fr auto 56px 150px; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line); align-items: baseline; }
.imx-row > :last-child { text-align: right; }
.imx-dropped { color: var(--bone-3); text-decoration: line-through; text-decoration-color: var(--bone-4); }
@keyframes imx-scan { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
@keyframes imx-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .imx-bar::after { animation: none; width: 100%; opacity: .5; }
  .imx-frame img { animation: none; }
}
@media (max-width: 760px) {
  .imx { padding-top: 24px; }
  .imx-hide-sm { display: none; }
  .imx-split, .imx-split-even { grid-template-columns: 1fr; }
  .imx-grid { grid-template-columns: 1fr; }
  .imx-row { grid-template-columns: 1fr auto; }
  .imx-row > :nth-child(2) { grid-column: 1; grid-row: 2; }
  .imx-row > :nth-child(3) { display: none; }
  .imx-row > :last-child { grid-row: 1 / span 2; grid-column: 2; align-self: center; }
  .imx-search { flex-direction: column; align-items: stretch; }
  .imx-metrics { grid-template-columns: repeat(2, auto); }
}
`
