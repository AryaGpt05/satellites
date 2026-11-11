/**
 * One photo at card size, as the gallery (summary hero and pass view) shows it (owner B):
 *
 *  - the frame's aspect is reserved by CSS before any pixel arrives (no layout shift);
 *  - a photo already decoded this session is drawn in the frame's first paint: no "acquiring", no fade (A2);
 *  - otherwise, once it is asked to `load` (the current photo and its neighbours ±2), it shows the instrument's
 *    ACQUIRING frame until the decoded image is ready, then fades in once (200 ms);
 *  - the pushbroom reveal plays only the FIRST time a photo is shown this session: the summary cover ('hero'),
 *    or a pass opened with its replay ('capture': in step with the globe's capture moment, owner C4). A photo
 *    already shown gets an echo of the scan instead when a replay crosses its capture moment: a scan line
 *    sweeps over the visible picture, nothing is hidden or reloaded;
 *  - the reticle marks the place at the centre; the expand control (and a click on the image) opens it large.
 */
import { useEffect, useRef, useState } from 'react'
import { cx, fmtLat, fmtLon, useReducedMotion } from '@/ui/system'
import { useCaptureMoment } from './capture'
import { decodedPhoto, hasPhotoElement, loadPhoto } from './images'
import { Img } from './Img'
import { Mark } from './Mark'
import { PushbroomReveal } from './PushbroomReveal'
import { Reticle } from './Reticle'
import { cropWidthKm, cardUrl, cardSpec, photoHeadingDeg, type Photo } from './lib/photos'
import { northInCropDeg } from '../../../api/_lib/toneRender'
import { scaleBarKm, sensorName } from './lib/captures'
import { int } from './lib/copy'
import { motionVector } from './lib/pushbroom'
import { markSeen, wasSeen } from './once'
import type { ResultsModel } from './model'
import s from './Gallery.module.css'

export interface PhotoFrameProps {
  photo: Photo
  model: ResultsModel
  /** Which view shows it (each keeps one <img> element per photo for the session, R3-1) */
  view: 'hero' | 'detail'
  /** Start loading (the current photo and its neighbours) */
  load: boolean
  /** This is the photo on screen now: it counts as seen once its pixels are up */
  current: boolean
  /** May play the pushbroom reveal if this photo has never been shown this session */
  reveal?: 'hero' | 'capture'
  /** Pass-view overlays: sensor chip, scale bar, north */
  chips?: boolean
  /** Echo the scan when a replay crosses this photo's capture moment (pass view, the selected pass) */
  echo?: boolean
  /** Reticle size (px, or a CSS length such as '26%') */
  reticle: number | string
  /** Phones: hold a reveal until the frame is on screen */
  gateOnVisible?: boolean
  onExpand?: (frame: HTMLElement) => void
  className?: string
  /** A tag on the picture, top left (a cover: why it leads, "Closest look" / "Last clear look") */
  tag?: { text: string; ice?: boolean }
  /** A one-line note on the picture, bottom left (the last clear look: why it leads; a clouded picture: how clouded) */
  note?: { text: string; warn?: boolean }
}

/** The useOnce key a capture's first showing is recorded under (shared with the shared-link picture). */
export const seenKeyOf = (p: Photo) => `capture:${p.capture.itemId}`

export function PhotoFrame({ photo, model, view, load, current, reveal, chips, echo, reticle, gateOnVisible, onExpand, className, tag, note }: PhotoFrameProps) {
  const reduced = useReducedMotion()
  const { capture, pass } = photo
  const url = cardUrl(capture)
  const seenKey = seenKeyOf(photo)
  const frameRef = useRef<HTMLDivElement>(null)
  // Decided once per mount: a first showing may reveal; anything else is simply there.
  const [mode] = useState<'reveal' | 'img'>(() => (reveal && current && pass && !wasSeen(seenKey) ? 'reveal' : 'img'))
  const [img, setImg] = useState<'idle' | 'loading' | 'ready' | 'error'>(() => (decodedPhoto(url) || hasPhotoElement(view, url) ? 'ready' : 'idle'))
  const [fadeIn, setFadeIn] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [locked, setLocked] = useState(mode === 'img')

  // Load when asked (and keep it: a shown photo never goes blank).
  useEffect(() => {
    if (mode !== 'img' || !load || img === 'ready') return
    const ctl = new AbortController()
    setImg('loading')
    loadPhoto(url, ctl.signal)
      .then(() => {
        if (ctl.signal.aborted) return
        setFadeIn(true)
        setImg('ready')
      })
      .catch(() => !ctl.signal.aborted && setImg('error'))
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, load, url, attempt])

  useEffect(() => {
    if (current && mode === 'img' && img === 'ready') markSeen(seenKey)
  }, [current, mode, img, seenKey])

  // Echo: a replay crossing the capture moment sweeps a scan line over the picture already on screen.
  const echoRef = useRef<HTMLSpanElement>(null)
  const revealing = useRef(false)
  useCaptureMoment(
    pass?.tClosest,
    {
      onCapture: () => {
        if (mode === 'reveal' && (revealing.current || !wasSeen(seenKey))) return
        if (img !== 'ready' && mode === 'img') return
        playEcho(frameRef.current, echoRef.current, photoHeadingDeg(capture, pass?.headingDeg ?? 180))
      },
    },
    !!echo && !reduced && current,
  )

  const widthKm = cropWidthKm(capture)
  const bar = scaleBarKm(widthKm)
  const northDeg = chips ? northInCropDeg(url) : 0
  const dim = photo.clouded ? ((capture.cloudCoverPct ?? 0) >= 90 ? s.dimOvercast : s.dimCloud) : undefined
  const alt = `${model.meta(pass?.norad ?? capture.norad ?? 0).name} image of ${model.report.place.label}. The place is at the centre.`
  const expand = () => frameRef.current && onExpand?.(frameRef.current)

  return (
    <div
      ref={frameRef}
      className={cx(s.frame, onExpand && s.zoomable, className)}
      data-photo-frame={photo.key}
      onClick={onExpand ? expand : undefined}
    >
      {mode === 'reveal' && pass ? (
        <PushbroomReveal
          src={url}
          view={view}
          headingDeg={photoHeadingDeg(capture, pass.headingDeg)}
          lines={cardSpec(capture).px}
          alt={alt}
          startAt={reveal === 'hero' ? 'hero' : 'capture'}
          tc={pass.tClosest}
          awaiting={pass.geostationary ? 'scan' : 'pass'}
          seenKey={seenKey}
          gateOnVisible={gateOnVisible}
          className={s.fill}
          frameClassName={cx(s.fillFrame, dim)}
          onPhase={(ph) => {
            revealing.current = ph === 'revealing'
            if (ph === 'done') setLocked(true)
          }}
          overlay={({ centreLocked }) => <Centre size={reticle} locked={centreLocked} />}
        />
      ) : (
        <>
          {img === 'ready' ? (
            <Img view={view} url={url} alt={alt} className={cx(s.img, dim)} fadeClass={fadeIn && !reduced ? s.imgFade : undefined} />
          ) : (
            <div className={s.waiting} role={img === 'loading' || img === 'error' ? 'status' : undefined}>
              {img === 'loading' ? (
                <span className={s.waitMain}>
                  Acquiring<span className={s.caret} aria-hidden />
                </span>
              ) : null}
              {img === 'error' ? (
                <>
                  <span className={s.waitMain}>No image returned</span>
                  <button
                    type="button"
                    className={s.retry}
                    onClick={(e) => {
                      e.stopPropagation()
                      setAttempt((n) => n + 1)
                    }}
                  >
                    Retry
                  </button>
                </>
              ) : null}
            </div>
          )}
          {img === 'ready' ? <Centre size={reticle} locked={locked} /> : null}
        </>
      )}
      <span ref={echoRef} className={s.echo} aria-hidden>
        <span className={s.echoLine} />
      </span>
      {chips ? (
        <span className={s.chips} aria-hidden>
          <span className={cx(s.chip, s.tl)}>
            {model.meta(pass?.norad ?? capture.norad ?? 0).name} · {sensorName(capture)}
          </span>
          <span className={s.scale} style={{ width: `${(bar / widthKm) * 100}%` }}>
            <span className={s.scaleBar} />
            <span className={s.scaleText}>{bar >= 1 ? int(bar) : bar} km</span>
          </span>
          <span className={cx(s.chip, s.br)}>
            {/* True north, turned from the photo's up (grid north on a native crop) by the meridian convergence. */}
            <svg width="8" height="10" viewBox="0 0 8 10" style={northDeg ? { transform: `rotate(${northDeg.toFixed(1)}deg)` } : undefined}>
              <path d="M4 0.5 7.5 9.5 4 7.2 0.5 9.5Z" fill="currentColor" />
            </svg>
            N
          </span>
        </span>
      ) : null}
      {tag ? <span className={cx(s.chip, s.tl, s.tagChip, tag.ice && s.ice)}>{tag.text}</span> : null}
      {note ? <span className={cx(s.chip, s.noteChip, note.warn && s.warn)}>{note.text}</span> : null}
      {onExpand ? (
        <button
          type="button"
          className={s.expand}
          aria-label="Expand the photo"
          title="Expand (F)"
          tabIndex={current ? 0 : -1}
          onClick={(e) => {
            e.stopPropagation()
            expand()
          }}
        >
          <Mark name="expand" size={14} />
        </button>
      ) : null}
    </div>
  )
}

function Centre({ size, locked }: { size: number | string; locked: boolean }) {
  return (
    <span className={s.centre} style={{ width: size, height: size }}>
      <Reticle size={typeof size === 'number' ? size : 100} locked={locked} className={s.reticleSvg} />
    </span>
  )
}

/**
 * The echo of the scan (owner C4 for a photo already shown): a signal line with its glow sweeps across the frame
 * along the satellite's motion, 1.6 s, linear like a pushbroom. Transform-only (compositor).
 */
function playEcho(frame: HTMLElement | null, echo: HTMLElement | null, headingDeg: number) {
  const line = echo?.firstElementChild as HTMLElement | null
  if (!frame || !echo || !line || typeof line.animate !== 'function') return
  const w = frame.clientWidth
  const h = frame.clientHeight
  const d = motionVector(headingDeg)
  const L = Math.ceil(Math.hypot(w, h))
  echo.style.width = `${L}px`
  echo.style.height = `${L}px`
  echo.style.transform = `translate(-50%, -50%) rotate(${(Math.atan2(d.y, d.x) * 180) / Math.PI}deg)`
  const anim = line.animate(
    [
      { transform: `translateX(${-L / 2 - 16}px)`, opacity: 1 },
      { transform: `translateX(${L / 2 + 16}px)`, opacity: 1 },
    ],
    { duration: 1600, easing: 'linear' },
  )
  echo.dataset.on = 'true'
  anim.onfinish = anim.oncancel = () => {
    echo.dataset.on = 'false'
  }
}

/** "43.4723°N 80.5449°W": the coordinate format the globe's place label uses. */
export const coordsOf = (lat: number, lon: number) => `${fmtLat(lat, 4)} ${fmtLon(lon, 4)}`
