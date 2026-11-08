/**
 * 04 / WATCHED CONTINUOUSLY: geostationary imagers that see the place all the time. They never "pass",
 * so they are a band, not events (DESIGN §2). GOES-East/West and Himawari get a small live frame: the
 * newest frame NASA GIBS actually has pixels for at the place (probed), else the best static guess.
 */
import { useEffect, useState } from 'react'
import { geoImageUrl, isGibsCollection, latestGeoImage } from '@/imagery'
import type { GeoWatcher, Place } from '@/types'
import { Glyph, LiveDot, cx, fmtLon } from '@/ui/system'
import { Paragraph } from './Text'
import { geoSentence, int } from './lib/copy'
import { fmtRelative } from './lib/time'
import s from './GeoWatchers.module.css'

const FRAME = { halfSizeKm: 400, px: 176 }

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
                <span className={s.countNum}>{int(g.imagesInWindow)}</span> images this week
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

type FrameState = { kind: 'loading' } | { kind: 'ok'; url: string; time?: number } | { kind: 'none'; reason: string }

function Frame({ watcher, place }: { watcher: GeoWatcher; place: Place }) {
  const gibs = watcher.gibs && isGibsCollection(watcher.gibs.collection) ? watcher.gibs.collection : undefined
  const [state, setState] = useState<FrameState>(() => (gibs ? { kind: 'loading' } : { kind: 'none', reason: 'No public frame' }))
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!gibs) return
    const ctl = new AbortController()
    setLoaded(false)
    setState({ kind: 'loading' })
    latestGeoImage(gibs, place, FRAME, { signal: ctl.signal })
      .then((r) => {
        if (ctl.signal.aborted) return
        // Nothing with pixels in the last two hours (e.g. a visible-only band at night): say so.
        if (r) setState({ kind: 'ok', url: r.url, time: r.time })
        else setState({ kind: 'none', reason: 'Dark side: no visible frame' })
      })
      .catch(() => {
        if (ctl.signal.aborted) return
        setState({ kind: 'ok', url: geoImageUrl(gibs, place, Date.now(), FRAME) })
      })
    return () => ctl.abort()
  }, [gibs, place])

  return (
    <div className={s.frameCol}>
      <div className={cx(s.frame, state.kind === 'ok' && loaded && s.frameOk)}>
        {state.kind === 'ok' ? (
          <img
            src={state.url}
            alt={`${watcher.name}: latest frame around the place`}
            crossOrigin="anonymous"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setState({ kind: 'none', reason: 'Frame unavailable' })}
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
