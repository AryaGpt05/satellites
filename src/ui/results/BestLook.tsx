/**
 * The summary's lead picture when no satellite photo exists at all: the geostationary imager that sees the
 * place every 10 minutes (GOES / Himawari), its latest frame. When photos exist, the summary leads with the
 * gallery instead (./Gallery.tsx, owner B), photo #1 being the closest look.
 */
import { useState } from 'react'
import { cx } from '@/ui/system'
import { Ago } from './Ago'
import { useGeoFrame } from './GeoWatchers'
import { Reticle } from './Reticle'
import type { BestLook as Best } from './lib/bestLook'
import type { ResultsModel } from './model'
import s from './BestLook.module.css'

const GEO_FRAME = { halfSizeKm: 400, px: 640 }

const GEO_RES: Record<string, string> = { 'gibs-goes-east': '2 km', 'gibs-goes-west': '2 km', 'gibs-himawari': '1 km' }
const GEO_SENSOR: Record<string, string> = { 'gibs-goes-east': 'ABI', 'gibs-goes-west': 'ABI', 'gibs-himawari': 'AHI' }

/** No picture from a passing satellite: the geostationary imager that watches the place all the time. */
export function GeoLook({ model, best }: { model: ResultsModel; best: Extract<Best, { kind: 'geo' }> }) {
  const w = best.watcher
  const probed = useGeoFrame(w, model.report.place, GEO_FRAME)
  const [failed, setFailed] = useState(false)
  const state = failed ? ({ kind: 'none', reason: 'The latest frame did not load' } as const) : probed
  const [loaded, setLoaded] = useState(false)
  const coll = w.gibs?.collection ?? ''
  return (
    <div className={s.hero}>
      <div className={cx(s.frame, s.geoFrame, state.kind !== 'ok' && s.waiting)}>
        {state.kind === 'ok' ? (
          <img
            src={state.url}
            alt={`${w.name}: latest frame around ${model.report.place.label}. The place is at the centre.`}
            crossOrigin="anonymous"
            decoding="async"
            className={cx(s.geoImg, loaded && s.geoImgOn)}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        ) : (
          <span className={s.geoNote}>{state.kind === 'loading' ? 'Acquiring the latest frame…' : state.reason}</span>
        )}
        <span className={s.centre}>
          <Reticle size={44} locked={loaded} />
        </span>
      </div>
      <div className={s.caption}>
        <div className={s.captionRow}>
          <span className={s.captionMain}>
            <b className={s.lead}>{w.name}</b> · {GEO_SENSOR[coll] ?? 'Imager'} · Latest frame
          </span>
          {state.kind === 'ok' && state.time ? <Ago t={state.time} base={{ end: Date.now(), at: Date.now() }} className={s.spot} /> : null}
        </div>
        <div className={s.captionSub}>
          Geostationary · {GEO_RES[coll] ?? '2 km'} · every {w.cadenceMin} min
        </div>
      </div>
    </div>
  )
}
