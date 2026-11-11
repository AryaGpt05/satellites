/**
 * 04 / WATCHED CONTINUOUSLY: geostationary imagers that see the place all the time. They never "pass",
 * so they are a band, not events (DESIGN §2). Where a public map service carries the satellite (GOES and
 * Himawari on NASA GIBS, the Meteosats on EUMETSAT), the row gets a small live frame: the newest one that
 * service actually has pixels for at the place (src/imagery/geoFrames.ts). A frame taken in infrared says so
 * on the picture, in ice (the night-capable hue, DESIGN §2): it is cloud tops, not the ground. A place at the
 * rim of a satellite's disc gets no frame from it (engine/geostationary.ts): half of it would be empty.
 */
import { useEffect, useState } from 'react'
import { isEumetsatSource, latestGeoFrame, type GeoFrameBand } from '@/imagery'
import type { GeoWatcher, LatLon, Place } from '@/types'
import { Glyph, LiveDot, fmtLon } from '@/ui/system'
import { Img } from './Img'
import { Paragraph } from './Text'
import { geoSentence, int } from './lib/copy'
import { fmtRelative } from './lib/time'
import s from './GeoWatchers.module.css'

const FRAME = { halfSizeKm: 400, px: 176 }

export type GeoFrameState = { kind: 'loading' } | { kind: 'ok'; url: string; time: number; band: GeoFrameBand; gridKm: number } | { kind: 'none'; reason: string }

/** Probe results this session, so a remount (back from a pass) shows the frame at once, never "Probing…" (A2). */
const probed = new Map<string, GeoFrameState>()
/** Frame URLs already shown: a remount draws them without the fade. */
export const shownGeoFrames = new Set<string>()

/**
 * The newest frame the watcher's service actually has pixels for at the place. Shared by the list's small frames
 * and the summary's geostationary best-look fallback.
 */
export function useGeoFrame(watcher: GeoWatcher, place: LatLon, spec: { halfSizeKm: number; px: number }): GeoFrameState {
  const source = watcher.frames
  const { halfSizeKm, px } = spec
  const key = `${source}|${place.lat},${place.lon}|${halfSizeKm}|${px}`
  const [state, setState] = useState<GeoFrameState>(() => probed.get(key) ?? (source ? { kind: 'loading' } : { kind: 'none', reason: watcher.rim ? 'Edge of its view' : 'No public frame' }))
  useEffect(() => {
    if (!source) return
    const hit = probed.get(key)
    if (hit) return setState(hit)
    const ctl = new AbortController()
    setState({ kind: 'loading' })
    latestGeoFrame(source, place, { halfSizeKm, px }, { signal: ctl.signal })
      .then((r) => {
        if (ctl.signal.aborted) return
        // Nothing with pixels (the place is off the imager's disc, or its service is not answering): say so.
        const v: GeoFrameState = r ? { kind: 'ok', ...r } : { kind: 'none', reason: 'No frame just now' }
        probed.set(key, v)
        setState(v)
      })
      .catch(() => undefined) // only an abort rejects: the next effect owns the state
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}

/** "infrared " for a frame that is cloud-top temperature, for the picture's alt text. */
export const bandWords = (band: GeoFrameBand) => (band === 'infrared' ? 'infrared ' : '')

export function GeoWatchers({ watchers, place, days }: { watchers: GeoWatcher[]; place: Place; days: number }) {
  if (!watchers.length)
    return <p className={s.none}>No operational geostationary weather imager sees this place above 5° elevation.</p>
  const lead = watchers[0]
  return (
    <div className={s.root}>
      <Paragraph sentences={[geoSentence(lead, days)]} className={s.lead} />
      <ul className={s.list}>
        {watchers.map((g) => (
          <li key={g.norad} className={s.item}>
            <Frame watcher={g} place={place} />
            <div className={s.info}>
              <div className={s.nameLine}>
                <Glyph name="weather-geo" size={13} />
                <span className={s.name}>{g.name}</span>
                <span className={s.operator}>{g.operator}</span>
              </div>
              <div className={s.meta}>
                {fmtLon(g.subLon, 1)} · {g.elevationDeg.toFixed(1)}° up · every {int(g.cadenceMin)} min
              </div>
              <div className={s.count}>
                <span className={s.countNum}>{int(g.imagesInWindow)}</span> images {Math.round(days) === 7 ? 'this week' : `in ${int(days)} days`}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {watchers.some((g) => g.frames && isEumetsatSource(g.frames)) ? (
        <p className={s.credit}>Contains modified EUMETSAT Meteosat data {new Date().getUTCFullYear()}</p>
      ) : null}
    </div>
  )
}

function Frame({ watcher, place }: { watcher: GeoWatcher; place: Place }) {
  const frame = useGeoFrame(watcher, place, FRAME)
  const [failed, setFailed] = useState(false)
  const state: GeoFrameState = failed ? { kind: 'none', reason: 'Frame unavailable' } : frame
  // The first showing this session fades in once; a remount re-attaches the same element at once (R3-1, A2).
  const [fade] = useState(() => !(state.kind === 'ok' && shownGeoFrames.has(state.url)))

  return (
    <div className={s.frameCol}>
      <div className={s.frame}>
        {state.kind === 'ok' ? (
          <Img
            view="geo"
            url={state.url}
            alt={`${watcher.name}: latest ${bandWords(state.band)}frame around the place`}
            fadeClass={fade ? s.frameFade : undefined}
            onReady={() => shownGeoFrames.add(state.url)}
            onError={() => setFailed(true)}
          />
        ) : (
          <span className={s.frameNote}>{state.kind === 'loading' ? 'Probing…' : state.reason}</span>
        )}
        <span className={s.reticle} aria-hidden />
        {state.kind === 'ok' && state.band === 'infrared' ? (
          <span className={s.band} title="Infrared: cloud tops by temperature, colder is lighter" aria-hidden>
            IR
          </span>
        ) : null}
      </div>
      <div className={s.frameTime}>
        {state.kind === 'ok' ? (
          <>
            <LiveDot className={s.dot} /> {fmtRelative(state.time, Date.now())}
          </>
        ) : (
          '—'
        )}
      </div>
    </div>
  )
}
