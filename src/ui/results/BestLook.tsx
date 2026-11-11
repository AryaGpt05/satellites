/**
 * The summary's lead picture when no satellite photo exists at all: the geostationary imager that sees the
 * place every 10 or 15 minutes (GOES, Himawari, Meteosat), its latest frame. When photos exist, the summary
 * leads with the gallery instead (./Gallery.tsx, owner B), photo #1 being the closest look.
 *
 * The caption reads off the frame itself: the pixel it is drawn on, and "Infrared" when it is cloud-top
 * temperature rather than light (a night frame of Himawari or Meteosat-9).
 */
import { useState } from 'react'
import { GEO_FRAMES } from '@/imagery'
import { cx } from '@/ui/system'
import { Ago } from './Ago'
import { Img } from './Img'
import { bandWords, shownGeoFrames, useGeoFrame } from './GeoWatchers'
import { Reticle } from './Reticle'
import type { BestLook as Best } from './lib/bestLook'
import type { ResultsModel } from './model'
import s from './BestLook.module.css'

const GEO_FRAME = { halfSizeKm: 400, px: 640 }

/** No picture from a passing satellite: the geostationary imager that watches the place all the time. */
export function GeoLook({ model, best }: { model: ResultsModel; best: Extract<Best, { kind: 'geo' }> }) {
  const w = best.watcher
  const probed = useGeoFrame(w, model.report.place, GEO_FRAME)
  const [failed, setFailed] = useState(false)
  const state = failed ? ({ kind: 'none', reason: 'The latest frame did not load' } as const) : probed
  const [loaded, setLoaded] = useState(() => state.kind === 'ok' && shownGeoFrames.has(state.url))
  const [fade] = useState(() => !loaded)
  const spec = w.frames ? GEO_FRAMES[w.frames] : undefined
  const infrared = state.kind === 'ok' && state.band === 'infrared'
  // Until the frame is in, the pixel of the layer asked for first, so the line is whole from the start.
  const gridKm = state.kind === 'ok' ? state.gridKm : spec?.layers[0].gridKm
  return (
    <div className={s.hero}>
      <div className={cx(s.frame, s.geoFrame, state.kind !== 'ok' && s.waiting)}>
        {state.kind === 'ok' ? (
          <Img
            view="geo-look"
            url={state.url}
            alt={`${w.name}: latest ${bandWords(state.band)}frame around ${model.report.place.label}. The place is at the centre.`}
            className={s.geoImg}
            fadeClass={fade ? s.geoImgFade : undefined}
            onReady={() => {
              if (state.kind === 'ok') shownGeoFrames.add(state.url)
              setLoaded(true)
            }}
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
            <b className={s.lead}>{w.name}</b> · {spec?.sensor ?? 'Imager'} · Latest frame
          </span>
          {state.kind === 'ok' ? <Ago t={state.time} base={{ end: Date.now(), at: Date.now() }} className={s.spot} /> : null}
        </div>
        <div className={s.captionSub}>
          Geostationary · {infrared ? <span className={s.geoBand}>Infrared</span> : null}
          {infrared ? ' · ' : null}
          {gridKm ? `${gridKm} km · ` : null}every {w.cadenceMin} min
        </div>
      </div>
    </div>
  )
}
