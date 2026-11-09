/**
 * 04 / WATCHED CONTINUOUSLY: geostationary imagers that see the place all the time. They never "pass",
 * so they are a band, not events (DESIGN §2). GOES-East/West and Himawari get a small live frame: the
 * newest frame NASA GIBS actually has pixels for at the place (probed), else the best static guess.
 */
import { useEffect, useState } from 'react'
import { geoImageUrl, isGibsCollection, latestGeoImage } from '@/imagery'
import type { GeoWatcher, LatLon, Place } from '@/types'
import { Glyph, LiveDot, fmtLon } from '@/ui/system'
import { Img } from './Img'
import { Paragraph } from './Text'
import { geoSentence, int } from './lib/copy'
import { fmtRelative } from './lib/time'
import s from './GeoWatchers.module.css'

const FRAME = { halfSizeKm: 400, px: 176 }

export type GeoFrameState = { kind: 'loading' } | { kind: 'ok'; url: string; time?: number } | { kind: 'none'; reason: string }

/**
 * The newest frame NASA GIBS actually has pixels for at the place (probed), else the best static
 * guess. Shared by the list's small frames and the summary's geostationary best-look fallback.
 */
/** Probe results this session, so a remount (back from a pass) shows the frame at once, never "Probing…" (A2). */
const probed = new Map<string, GeoFrameState>()
/** Frame URLs already shown: a remount draws them without the fade. */
export const shownGeoFrames = new Set<string>()

export function useGeoFrame(watcher: GeoWatcher, place: LatLon, spec: { halfSizeKm: number; px: number }): GeoFrameState {
  const gibs = watcher.gibs && isGibsCollection(watcher.gibs.collection) ? watcher.gibs.collection : undefined
  const { halfSizeKm, px } = spec
  const key = `${gibs}|${place.lat},${place.lon}|${halfSizeKm}|${px}`
  const [state, setState] = useState<GeoFrameState>(() => probed.get(key) ?? (gibs ? { kind: 'loading' } : { kind: 'none', reason: 'No public frame' }))
  useEffect(() => {
    if (!gibs) return
    const hit = probed.get(key)
    if (hit) return setState(hit)
    const ctl = new AbortController()
    setState({ kind: 'loading' })
    const opts = { halfSizeKm, px }
    latestGeoImage(gibs, place, opts, { signal: ctl.signal })
      .then((r) => {
        if (ctl.signal.aborted) return
        // Nothing with pixels in the last two hours (e.g. a visible-only band at night): say so.
        const v: GeoFrameState = r ? { kind: 'ok', url: r.url, time: r.time } : { kind: 'none', reason: 'Dark side: no visible frame' }
        probed.set(key, v)
        setState(v)
      })
      .catch(() => {
        if (ctl.signal.aborted) return
        setState({ kind: 'ok', url: geoImageUrl(gibs, place, Date.now(), opts) })
      })
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}

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
            alt={`${watcher.name}: latest frame around the place`}
            fadeClass={fade ? s.frameFade : undefined}
            onReady={() => shownGeoFrames.add(state.url)}
            onError={() => setFailed(true)}
          />
        ) : (
          <span className={s.frameNote}>{state.kind === 'loading' ? 'Probing…' : state.reason}</span>
        )}
        <span className={s.reticle} aria-hidden />
      </div>
      <div className={s.frameTime}>
        {state.kind === 'ok' && state.time ? (
          <>
            <LiveDot className={s.dot} /> {fmtRelative(state.time, Date.now())}
          </>
        ) : state.kind === 'ok' ? (
          'Latest'
        ) : (
          '—'
        )}
      </div>
    </div>
  )
}
