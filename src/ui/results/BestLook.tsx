/**
 * BEST LOOK (decision #1): the clearest real picture of the place, on screen the moment results land.
 *
 *   desktop  under the headline, content width, 16:9 (3:2 on screens ≥ 860px tall), a 28px caption
 *            row ("BEST LOOK · SENTINEL-2C · SUN 1 NOV 11:21 · 10 M" | "CLEAR AT YOUR SPOT"), then
 *            "Open this pass" (primary) and "Share". The image opens the pass too.
 *   phones   the first block of the sheet body, 16:9, a two-line caption; the whole block is one tap
 *            target with a trailing "OPEN →" (no second signal button on the peek).
 *
 * It reveals pushbroom-style once per report (same URL as PassDetail, so opening the pass is a cache
 * hit), after the panel has landed and as the camera arrives. Fallbacks: a daily weather mosaic
 * (honestly labelled as coarse), then the lead geostationary imager's latest frame.
 */
import { useState, type KeyboardEvent } from 'react'
import type { Pass } from '@/types'
import { Button, Glyph, cx, useIsMobile } from '@/ui/system'
import { Ago } from './Ago'
import { useGeoFrame } from './GeoWatchers'
import { PushbroomReveal } from './PushbroomReveal'
import type { BestLook as Best } from './lib/bestLook'
import { cropSpec, displayUrl, isDailyMosaic, sensorName } from './lib/captures'
import { int } from './lib/copy'
import type { ResultsModel } from './model'
import { useOnce } from './once'
import s from './BestLook.module.css'

interface Props {
  model: ResultsModel
  best: Best
  onOpen: (p: Pass) => void
  onShare?: (p: Pass) => void
}

const GEO_FRAME = { halfSizeKm: 400, px: 640 }

export function BestLook({ model, best, onOpen, onShare }: Props) {
  if (best.kind === 'geo') return <GeoLook model={model} best={best} />
  return <CaptureLook model={model} best={best} onOpen={onOpen} onShare={onShare} />
}

function CaptureLook({ model, best, onOpen, onShare }: Props & { best: Extract<Best, { kind: 'detailed' | 'mosaic' }> }) {
  const mobile = useIsMobile()
  const { pass, capture } = best
  const meta = model.meta(pass.norad)
  const t = model.times(pass)
  const src = displayUrl(capture, cropSpec(capture.collection))
  const first = useOnce(`hero:${model.report.windowEnd}:${capture.id}`)
  const mosaic = isDailyMosaic(capture)
  const res = `${int(capture.gsdM)} m`
  const spot = spotWords(capture.spot, capture.cloudCoverPct)
  // The phone caption's second line also carries the day, time and zone: short words, never cut.
  const spotShort = spotWords(capture.spot, capture.cloudCoverPct, true)
  const lead = mosaic ? `Daily mosaic · ${meta.name} ${sensorName(capture)}` : `Best look · ${meta.name}`
  const open = () => onOpen(pass)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  }
  const alt = `${meta.name} image of ${model.report.place.label}, ${t.day} ${t.time} ${t.zone}. The place is at the centre.`

  const picture = (
    <PushbroomReveal
      src={src}
      headingDeg={pass.headingDeg}
      lines={cropSpec(capture.collection).px}
      alt={alt}
      startAt="hero"
      instant={!first}
      frameClassName={s.frame}
      overlay={({ centreLocked }) => <span className={cx(s.mark, centreLocked && s.markOn)} aria-hidden />}
    />
  )

  if (mobile) {
    return (
      <div className={s.hero} role="button" tabIndex={0} onClick={open} onKeyDown={onKey} aria-label={`Open the best look: ${alt}`}>
        {picture}
        <div className={s.mCaption}>
          <span className={s.mLines}>
            <span className={s.mLine}>
              <b className={mosaic ? undefined : s.lead}>{lead}</b> · {res}
              {mosaic ? ' · coarse, but real' : null}
            </span>
            <span className={s.mLine}>
              {t.day} · {t.time}
              <span className={s.zone}> {t.zone}</span>
              {spotShort ? <> · {spotShort}</> : null}
            </span>
          </span>
          <span className={s.open}>
            Open <Glyph name="arrow-right" size={11} />
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className={s.hero}>
      <button type="button" className={s.pictureBtn} onClick={open} aria-label={`Open this pass: ${alt}`}>
        {picture}
      </button>
      <div className={s.caption}>
        <div className={s.captionRow}>
          <span className={s.captionMain}>
            <b className={mosaic ? undefined : s.lead}>{lead}</b>
          </span>
          {spot ? <span className={s.spot}>{spot}</span> : mosaic ? <span className={s.spot}>Coarse, but real</span> : null}
        </div>
        <div className={s.captionSub}>
          {t.day} · {t.time} {t.zone} · {res} · {sensorName(capture)}
        </div>
      </div>
      <div className={s.actions}>
        <Button variant="primary" onClick={open}>
          Open this pass
          <Glyph name="arrow-right" size={12} />
        </Button>
        {onShare ? (
          <Button onClick={() => onShare(pass)}>
            <Glyph name="share" size={13} />
            Share
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** The words for the spot classification, or the scene cloud when the spot wasn't read. */
function spotWords(spot: string | undefined, cloudPct: number | undefined, short = false): string | undefined {
  switch (spot) {
    case 'clear':
      return short ? 'Clear' : 'Clear at your spot'
    case 'cirrus':
      return 'Thin cirrus'
    case 'cloud':
      return short ? 'Cloud' : 'Cloud at your spot'
    case 'shadow':
      return short ? 'Shadow' : 'Cloud shadow at your spot'
    default:
      return cloudPct !== undefined ? `Cloud ${int(cloudPct)}%` : undefined
  }
}

const GEO_RES: Record<string, string> = { 'gibs-goes-east': '2 km', 'gibs-goes-west': '2 km', 'gibs-himawari': '1 km' }
const GEO_SENSOR: Record<string, string> = { 'gibs-goes-east': 'ABI', 'gibs-goes-west': 'ABI', 'gibs-himawari': 'AHI' }

/** No picture from a passing satellite: the geostationary imager that watches the place all the time. */
function GeoLook({ model, best }: { model: ResultsModel; best: Extract<Best, { kind: 'geo' }> }) {
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
        <span className={cx(s.mark, loaded && s.markOn)} aria-hidden />
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
