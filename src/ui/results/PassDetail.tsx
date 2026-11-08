/**
 * Pass detail (03 / PASSES › one pass): the sentence, the capture (pushbroom reveal) or a plan view
 * when no image exists, the geometry readouts, and the replay controls.
 *
 * Copy always uses Pass.tClosest, never Capture.datetime (Sentinel-2 archive times are the datatake
 * start, minutes before the satellite was over the place).
 */
import { useEffect, useState } from 'react'
import { spotCloud, type SpotCloud } from '@/imagery'
import type { Capture, Pass } from '@/types'
import { Glyph, Readout, Rule, ScrambleOnce, cx, fmtLat, fmtLon, fmtNorad, fmtUtc } from '@/ui/system'
import { PassPlan } from './PassPlan'
import { PushbroomReveal } from './PushbroomReveal'
import { ReplayControls } from './ReplayControls'
import { Paragraph } from './Text'
import { archiveName, captureFor, cropSpec, displayUrl, downloadUrl, isDailyMosaic, productLabel, scaleBarKm, sensorName, slug } from './lib/captures'
import { compassAbbr, dec1, dec2, int, passSentences } from './lib/copy'
import type { SatMeta } from './lib/meta'
import { replayWindow } from './lib/replay'
import { fmtDuration, fmtLocalDay, fmtLocalTime, zoneAbbr } from './lib/time'
import type { ResultsModel } from './model'
import r from './results.module.css'
import s from './PassDetail.module.css'

export function PassDetail({ model, pass }: { model: ResultsModel; pass: Pass }) {
  const { report, tz } = model
  const meta = model.meta(pass.norad)
  const capture = captureFor(report, pass)
  const place = report.place
  const cloud = useSpotCloud(capture, place)
  const sentences = passSentences({ pass, meta, capture, timeZone: tz, placeLabel: place.label })

  return (
    <div className={s.detail}>
      {/* The picture first: the reveal is the moment this whole product exists for. */}
      <section className={r.section} aria-label={capture ? 'Capture' : 'Plan view'}>
        {capture ? (
          <CaptureView capture={capture} pass={pass} meta={meta} model={model} />
        ) : (
          <>
            <PassPlan pass={pass} meta={meta} lat={place.lat} lon={place.lon} />
            <p className={r.footnote}>{noImageNote(pass, meta)}</p>
          </>
        )}
        <Paragraph sentences={sentences} />
        {capture && !isDailyMosaic(capture) ? <SpotLine state={cloud} /> : null}
        {meta.profile?.blurb ? <p className={r.blurb}>{meta.profile.blurb}</p> : null}
      </section>

      <section className={r.section} aria-label="Geometry">
        <Rule index="03.1" className={r.rule}>
          Geometry
        </Rule>
        <Geometry pass={pass} meta={meta} capture={capture} cloud={cloud} tz={tz} />
      </section>

      <section className={r.section} aria-label="Replay">
        <Rule index="03.2" className={r.rule}>
          Replay
        </Rule>
        <ReplayControls pass={pass} />
      </section>
    </div>
  )
}


function noImageNote(p: Pass, meta: SatMeta): string {
  switch (p.verdict) {
    case 'could':
      // The sentence below says what we can't know; this only says why there is no picture.
      return meta.category === 'radar'
        ? 'No public image: this radar operator’s archive is private. Plan view of the pass.'
        : 'No public image: commercial archives are private. Plan view of the pass.'
    case 'likely':
      return meta.category === 'open-optical'
        ? 'No published scene matches this pass yet. Sentinel-2 and Landsat scenes usually appear within a day.'
        : 'No image to show for this pass.'
    case 'overhead':
      return 'Crewed stations carry cameras, but their photos are not published by place and time.'
    default:
      return 'The image for this pass is not available.'
  }
}

// ── capture ───────────────────────────────────────────────────────────────────────────────

function CaptureView({ capture, pass, meta, model }: { capture: Capture; pass: Pass; meta: SatMeta; model: ResultsModel }) {
  const spec = cropSpec(capture.collection)
  const src = displayUrl(capture, spec)
  const widthKm = spec.halfSizeKm * 2
  const mosaic = isDailyMosaic(capture)
  const place = model.report.place
  const [dl, setDl] = useState<'idle' | 'busy' | 'err'>('idle')
  const bar = scaleBarKm(widthKm)

  const download = async () => {
    if (dl === 'busy') return
    setDl('busy')
    const url = downloadUrl(capture, spec)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      const ext = blob.type.includes('png') ? 'png' : 'jpg'
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `overflight-${slug(meta.name)}-${slug(place.label)}-${new Date(pass.tClosest).toISOString().slice(0, 10)}.${ext}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      setDl('idle')
    } catch {
      // The render could not be fetched as a file: offer it as a plain link instead (a window.open
      // here, after an await, would be popup-blocked).
      setDl('err')
    }
  }

  return (
    <div className={s.capture}>
      <PushbroomReveal
        key={src}
        src={src}
        headingDeg={pass.headingDeg}
        lines={spec.px}
        alt={`${meta.name} image of ${place.label}, ${fmtLocalDay(pass.tClosest, model.tz)}. The place is at the centre.`}
        acquiringNote={capture.provider === 'gibs' ? 'NASA GIBS · rendering the mosaic tile' : `${archiveName(capture)} renders on demand · 1–3 s`}
        caption={
          <>
            {productLabel(capture)} · {widthKm >= 100 ? int(widthKm) : dec1(widthKm)} km
          </>
        }
        overlay={({ centreLocked, phase }) => (
          <CaptureOverlay
            locked={centreLocked}
            visible={phase === 'revealing' || phase === 'done'}
            done={phase === 'done'}
            satLabel={`${meta.name} · ${sensorName(capture)}`}
            coords={`${fmtLat(place.lat, 4)} ${fmtLon(place.lon, 4)}`}
            barKm={bar}
            widthKm={widthKm}
          />
        )}
      />
      {mosaic ? (
        <p className={r.footnote}>
          A daily mosaic: NASA stitches each day’s swaths into one picture at {int(capture.gsdM)} m per pixel. Coarse, but real, and from this pass’s day.
        </p>
      ) : null}
      <div className={s.links}>
        {dl === 'err' ? (
          <a className={s.link} href={downloadUrl(capture, spec)} target="_blank" rel="noopener noreferrer">
            <Glyph name="arrow-up-right" size={12} />
            Open image to save it
          </a>
        ) : (
          <button type="button" className={s.link} onClick={download} disabled={dl === 'busy'}>
            <Glyph name="download" size={12} />
            {dl === 'busy' ? 'Downloading…' : 'Download image'}
          </button>
        )}
        {capture.sourceUrl ? (
          <a className={s.link} href={capture.sourceUrl} target="_blank" rel="noopener noreferrer">
            <Glyph name="arrow-up-right" size={12} />
            View source · {archiveName(capture)}
          </a>
        ) : null}
      </div>
    </div>
  )
}

function CaptureOverlay({
  locked,
  visible,
  done,
  satLabel,
  coords,
  barKm,
  widthKm,
}: {
  locked: boolean
  visible: boolean
  done: boolean
  satLabel: string
  coords: string
  barKm: number
  widthKm: number
}) {
  return (
    <div className={cx(s.overlay, visible && s.overlayOn)}>
      <svg className={cx(s.reticle, locked && s.reticleLocked)} viewBox="-50 -50 100 100" aria-hidden>
        {/* ink knock-out under the signal strokes keeps the mark legible over any terrain */}
        <g className={s.knock}>
          <circle r="15" />
          <path d="M0 -30V-20M0 20V30M-30 0H-20M20 0H30" />
        </g>
        <circle r="15" className={s.ring} />
        <path d="M0 -30V-20M0 20V30M-30 0H-20M20 0H30" className={s.ticks} />
        <circle r="1.6" className={s.dot} />
      </svg>
      <span className={cx(s.chip, s.tl)}>{satLabel}</span>
      <span className={cx(s.chip, s.tr)} aria-hidden>
        <svg width="8" height="10" viewBox="0 0 8 10">
          <path d="M4 0.5 7.5 9.5 4 7.2 0.5 9.5Z" fill="currentColor" />
        </svg>
        N
      </span>
      <span className={cx(s.scale, done && s.scaleOn)} style={{ width: `${(barKm / widthKm) * 100}%` }}>
        <span className={s.bar} />
        <span className={s.scaleText}>{barKm >= 1 ? int(barKm) : barKm} km</span>
      </span>
      <span className={cx(s.chip, s.br)}>{coords}</span>
    </div>
  )
}

// ── spot cloud ────────────────────────────────────────────────────────────────────────────

type CloudState = 'checking' | SpotCloud | 'none'

function useSpotCloud(capture: Capture | undefined, place: { lat: number; lon: number }): CloudState {
  const [state, setState] = useState<CloudState>('none')
  useEffect(() => {
    if (!capture || isDailyMosaic(capture)) return setState('none')
    const ctl = new AbortController()
    setState('checking')
    spotCloud(capture, place, ctl.signal)
      .then((v) => !ctl.signal.aborted && setState(v))
      .catch(() => !ctl.signal.aborted && setState('unknown'))
    return () => ctl.abort()
  }, [capture, place])
  return state
}

function SpotLine({ state }: { state: CloudState }) {
  if (state === 'none' || state === 'unknown') return null
  const text =
    state === 'checking'
      ? 'Reading the pixel at your spot'
      : state === 'clear'
        ? 'The pixel at your spot is clear'
        : state === 'cloud'
          ? 'The archive flags cloud or thin cirrus over your spot'
          : 'Your spot was in cloud shadow'
  return (
    <p className={cx(s.spot, state === 'checking' && s.spotChecking)} aria-live="polite">
      <span className={cx(s.spotMark, state === 'clear' && s.spotClear)} aria-hidden />
      {text}
      {state === 'checking' ? '…' : '.'}
    </p>
  )
}

// ── geometry ──────────────────────────────────────────────────────────────────────────────

function Geometry({ pass: p, meta, capture, cloud, tz }: { pass: Pass; meta: SatMeta; capture?: Capture; cloud: CloudState; tz: string }) {
  const [utcDate, utcTime] = fmtUtc(p.tClosest).split(' ')
  const res = capture?.gsdM ?? meta.profile?.resolutionM
  const prof = meta.profile
  const w = replayWindow(p)
  const cloudValue =
    cloud === 'checking'
      ? 'Checking…'
      : cloud === 'clear'
        ? 'Clear at spot'
        : cloud === 'cloud'
          ? 'Cloud / cirrus at spot'
          : cloud === 'shadow'
            ? 'Shadow at spot'
            : capture?.cloudCoverPct !== undefined
              ? `${int(capture.cloudCoverPct)}%`
              : '—'
  const cells: { label: string; value: React.ReactNode; unit?: string; wide?: boolean }[] = [
    { label: 'Closest · UTC', value: utcTime, unit: utcDate },
    { label: `Closest · local`, value: fmtLocalTime(p.tClosest, tz, true), unit: `${fmtLocalDay(p.tClosest, tz)} ${zoneAbbr(p.tClosest, tz)}` },
    { label: 'Altitude', value: dec1(p.altitudeKm), unit: 'km' },
    { label: 'Off-nadir', value: `${dec1(p.offNadirDeg)}°` },
    { label: 'Ground distance', value: dec1(p.groundDistanceKm), unit: 'km' },
    { label: 'Elevation from you', value: `${dec1(p.elevationDeg)}°`, unit: compassAbbr(p.azimuthDeg) },
    { label: 'Ground speed', value: dec2(p.groundSpeedKmS), unit: 'km/s' },
    { label: 'Heading', value: `${dec1(p.headingDeg)}°`, unit: `${compassAbbr(p.headingDeg)} · ${p.node === 'ascending' ? 'Asc' : 'Desc'}` },
    { label: 'Sun elevation', value: `${dec1(p.sunElevationDeg)}°`, unit: p.sunElevationDeg >= 0 ? 'Day' : p.sunElevationDeg >= -6 ? 'Twilight' : 'Night' },
    { label: 'Resolution', value: res !== undefined ? (res < 1 ? dec2(res) : int(res)) : '—', unit: res !== undefined ? 'm' : undefined },
    prof?.maxOffNadirDeg
      ? { label: 'Field of regard', value: `±${int(prof.maxOffNadirDeg)}°` }
      : { label: 'Swath', value: prof?.swathKm ? int(prof.swathKm) : '—', unit: prof?.swathKm ? 'km' : undefined },
    {
      label: 'Cloud',
      value: cloudValue,
      unit: capture?.cloudCoverPct !== undefined && cloud !== 'none' && cloud !== 'unknown' ? `${int(capture.cloudCoverPct)}% scene` : undefined,
    },
    {
      label: p.tEnd > p.tStart ? (p.inSwath ? 'In swath' : 'In view') : 'Window',
      value: p.tEnd > p.tStart ? `${fmtUtc(p.tStart).split(' ')[1]} → ${fmtUtc(p.tEnd).split(' ')[1]}` : `${fmtUtc(w[0]).split(' ')[1]} → ${fmtUtc(w[1]).split(' ')[1]}`,
      unit: p.tEnd > p.tStart ? fmtDuration(p.tEnd - p.tStart) : 'UTC',
      wide: true,
    },
    // Full width, like the window above it: 12 paired cells, then two wide rows (no orphan cell).
    { label: 'NORAD', value: <ScrambleOnce text={fmtNorad(p.norad)} />, unit: meta.operator, wide: true },
  ]
  return (
    <div className={r.grid}>
      {cells.map((c) => (
        <div key={c.label} className={cx(r.cell, c.wide && r.cellWide)}>
          <Readout label={c.label} value={c.value} unit={c.unit} />
        </div>
      ))}
    </div>
  )
}
