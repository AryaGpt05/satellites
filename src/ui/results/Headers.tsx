/**
 * Panel headers.
 *
 * OverviewHeader: one header from computing through results (decision #10). Two mono rows on
 * desktop (≈ 76 px), so the best-look picture fits above the fold:
 *
 *   COMPUTING · T+1.84 S                           CANCEL [ESC]       ← computing
 *   7 DAYS · 1 → 8 NOV  (● VERIFYING WEATHER MOSAICS)  NEW SEARCH [ESC] ← results
 *   WATERLOO · 43.4723°N 80.5449°W · AMERICA/TORONTO                   ← the same node throughout
 *
 * Phones add the headline and its second line under row 1 (the peek shows them with the hero), and
 * drop the place row once results land (the headline names the place).
 *
 * DetailHeader: back crumb, "3 / 31 ‹ ›" stepping within the pass's verdict (chevrons, so stepping never
 * reads as the ← of "back"), name, local time. A pass with a photo drops the stepper (the gallery under it
 * has its own counter and ‹ ›) and its name and time change in place, with a short fade, as you swipe.
 * A share recipient sees a one-line tag above it (R2R10): SHARED WITH YOU · SENTINEL-2C PHOTOGRAPHED WATERLOO.
 */
import { memo, useEffect, useRef, type KeyboardEvent } from 'react'
import { timeZoneAt } from '@/imagery'
import { useApp } from '@/state/store'
import type { Pass, Place } from '@/types'
import { SearchBox } from '@/ui/landing/SearchBox'
import { Glyph, Kbd, LiveDot, ScrambleOnce, cx, fmtLat, fmtLon } from '@/ui/system'
import { secs } from './ComputingBody'
import { Mark } from './Mark'
import { useOnce } from './once'
import { ReplayStrip } from './ReplayControls'
import { Headline, MoreLine } from './Summary'
import { clearPass } from './actions'
import { glyphForPass, markColorVar } from './lib/meta'
import { stepPass } from './lib/timeline'
import { fmtDayMonth, zoneLabel } from './lib/time'
import type { ResultsModel } from './model'
import s from './results.module.css'

/** A live dot that renders once: its wall-second sync must not run on every header render. */
const StillLiveDot = memo(function StillLiveDot() {
  return <LiveDot className={s.liveDot} />
})

// ── recent places (this session) ─────────────────────────────────────────────────────────

const recent: Place[] = []
/** Remember a place whose results were shown (newest first, unique, at most 4). */
export function rememberPlace(p: Place) {
  const i = recent.findIndex((r) => Math.abs(r.lat - p.lat) < 1e-4 && Math.abs(r.lon - p.lon) < 1e-4)
  if (i >= 0) recent.splice(i, 1)
  recent.unshift(p)
  recent.length = Math.min(recent.length, 4)
}

// ── overview / computing ─────────────────────────────────────────────────────────────────

interface OverviewHeaderProps {
  place?: Place
  model?: ResultsModel
  computing: boolean
  /** performance.now() when computing started (for T+) */
  t0: number
  mobile: boolean
  enter: boolean
  searching: boolean
  onBack: () => void
  onCancel: () => void
  onOpenSearch?: () => void
  onCloseSearch: () => void
  onSearch?: (p: Place) => void
  onRetry?: () => void
}

export function OverviewHeader(props: OverviewHeaderProps) {
  const { place, model, computing, mobile, enter, searching } = props
  const tz = model?.tz ?? (place ? timeZoneAt(place.lat, place.lon) : undefined)
  const partial = !computing && !!model?.report.partial
  const showPlaceRow = !!place && (!mobile || computing) && !searching

  return (
    <div className={s.overviewHead}>
      <div className={s.headTop}>
        <span className={s.headLeft}>
          {computing ? (
            <ComputeClock t0={props.t0} />
          ) : (
            <>
              <span className={cx(s.headSwap, partial && s.headSwapOff)} aria-hidden={partial}>
                {model ? windowText(model) : null}
              </span>
              <span className={cx(s.headSwap, s.live, !partial && s.headSwapOff)} aria-hidden={!partial}>
                <StillLiveDot />
                Verifying weather mosaics
              </span>
            </>
          )}
        </span>
        {computing ? (
          <button type="button" className={s.crumb} onClick={props.onCancel} aria-keyshortcuts="Escape">
            Cancel
            <span className={s.kbdHover} aria-hidden>
              <Kbd>Esc</Kbd>
            </span>
          </button>
        ) : searching ? (
          <button type="button" className={s.crumb} onClick={props.onCloseSearch}>
            <Glyph name="close" size={11} />
            Close
          </button>
        ) : (
          <button type="button" className={s.crumb} onClick={props.onOpenSearch ?? props.onBack} aria-keyshortcuts="Escape">
            <Glyph name="search" size={11} />
            New search
            <span className={s.kbdHover} aria-hidden>
              <Kbd>Esc</Kbd>
            </span>
          </button>
        )}
      </div>

      {showPlaceRow && place ? (
        <div className={s.placeRow}>
          <b>{place.label}</b>
          <span className={s.sep}>·</span>
          <Coords lat={place.lat} lon={place.lon} />
          {tz ? (
            <>
              <span className={s.sep}>·</span>
              <span className={s.tzText}>{zoneLabel(Date.now(), tz)}</span>
            </>
          ) : null}
        </div>
      ) : null}

      {searching ? (
        <InlineSearch onSearch={props.onSearch} onClose={props.onCloseSearch} current={place} />
      ) : mobile && model && !computing ? (
        <div className={s.mHead}>
          <Headline model={model} compact enter={enter} />
          <MoreLine model={model} compact enter={enter} onRetry={props.onRetry} />
        </div>
      ) : null}
    </div>
  )
}

/** Coordinates scramble once per place this session, even if the panel is remounted. */
function Coords({ lat, lon }: { lat: number; lon: number }) {
  const text = `${fmtLat(lat)} ${fmtLon(lon)}`
  const first = useOnce(`coords:${text}`)
  return first ? <ScrambleOnce key={text} text={text} className={s.coordsText} /> : <span className={s.coordsText}>{text}</span>
}

/** "7 days · 1 → 8 Nov" */
function windowText(model: ResultsModel): string {
  const { report, tz, windowDays } = model
  const a = fmtDayMonth(report.windowStart, tz)
  const b = fmtDayMonth(report.windowEnd, tz)
  const [da, ma] = a.split(' ')
  const [db, mb] = b.split(' ')
  return `${Math.round(windowDays)} days · ${ma === mb ? da : a} → ${db} ${mb}`
}

/** "COMPUTING · T+1.84 S", written through a ref at 10 Hz (the header never re-renders for it). */
function ComputeClock({ t0 }: { t0: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = `T+${secs(performance.now() - t0)}`
    }
    tick()
    const id = window.setInterval(tick, 100)
    return () => window.clearInterval(id)
  }, [t0])
  return (
    <>
      <span className={s.computingWord}>Computing</span>
      <span className={s.sep}>·</span>
      <span ref={ref} className={s.clock} />
    </>
  )
}

/** R16: a second place in one step. The first Esc closes the field (a second one leaves, as ever). */
function InlineSearch({ onSearch, onClose, current }: { onSearch?: (p: Place) => void; onClose: () => void; current?: Place }) {
  const chips = recent.filter((p) => !current || Math.abs(p.lat - current.lat) > 1e-4 || Math.abs(p.lon - current.lon) > 1e-4).slice(0, 3)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }
  const submit = (p: Place) => {
    onSearch?.(p)
    onClose()
  }
  return (
    <div className={s.inlineSearch} onKeyDownCapture={onKey}>
      <SearchBox onSubmit={submit} autoFocus />
      {chips.length ? (
        <div className={s.recent}>
          <span className={s.recentLabel}>Recent</span>
          {chips.map((p) => (
            <button key={`${p.lat},${p.lon}`} type="button" className={s.chip} onClick={() => submit(p)}>
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ── pass detail ──────────────────────────────────────────────────────────────────────────

interface DetailHeaderProps {
  model: ResultsModel
  pass: Pass
  mobile: boolean
  onSelect: (p: Pass) => void
  /** Phones: show the compact replay strip (replay/scrub, camera not flying) */
  strip: boolean
  /** A pass with a photo: the gallery steps (no stepper here); the title changes in place */
  photo?: boolean
  /** A shared link is open (R2R10): the tag above the header */
  shared?: { sat: string; place: string }
}

/** Pass header: back, position within the verdict with ‹ ›, the satellite, its local time. */
export function DetailHeader({ model, pass, mobile, onSelect, strip, photo, shared }: DetailHeaderProps) {
  const meta = model.meta(pass.norad)
  const lane = model.lanes[pass.verdict].passes
  const index = lane.findIndex((p) => p.id === pass.id)
  const step = (dir: 1 | -1) => {
    const next = stepPass(model.lanes, pass, dir)
    if (next && next.id !== pass.id) onSelect(next)
  }
  const t = model.times(pass)
  // The strip shows once the camera has arrived and the scene is replaying or held (MOB-16).
  const replayOn = useApp((st) => st.timeMode !== 'live' && !st.cameraFlight.flying)
  // A quiet selection (a swipe) changes the title in place: a 160 ms fade of the words, never the header.
  const firstId = useRef(pass.id)
  const titleKey = photo ? pass.id : 'one'
  const titleCls = photo && pass.id !== firstId.current ? s.titleIn : undefined
  return (
    <div className={s.detailHead}>
      {shared ? (
        <p className={s.sharedTag}>
          <span className={s.sharedDot} aria-hidden />
          <span className={s.sharedText}>
            Shared with you · {shared.sat} photographed {shared.place}
          </span>
        </p>
      ) : null}
      <div className={s.headTop}>
        <button type="button" className={s.crumb} onClick={clearPass} aria-keyshortcuts="Escape">
          <Glyph name="arrow-left" size={11} />
          All passes
          <span className={s.kbdHover} aria-hidden>
            <Kbd>Esc</Kbd>
          </span>
        </button>
        <span className={cx(s.stepper, photo && s.stepperOff)} aria-hidden={photo || undefined}>
          <span className={s.position} aria-label={`Pass ${index + 1} of ${lane.length} of this kind`}>
            {index + 1} / {lane.length}
          </span>
          <button type="button" className={s.stepBtn} onClick={() => step(-1)} disabled={index <= 0} aria-label="Previous pass of this kind" aria-keyshortcuts="ArrowLeft" title="Previous (←)">
            <Mark name="chevron-left" size={12} />
          </button>
          <button
            type="button"
            className={s.stepBtn}
            onClick={() => step(1)}
            disabled={index >= lane.length - 1}
            aria-label="Next pass of this kind"
            aria-keyshortcuts="ArrowRight"
            title="Next (→)"
          >
            <Mark name="chevron-right" size={12} />
          </button>
        </span>
      </div>
      {mobile ? (
        // Phones: name and time on one line, so the flight snap stays low (≤ 25 % of the screen).
        <div key={titleKey} className={cx(s.passTitle, s.passTitleCompact, titleCls)}>
          <Mark name={glyphForPass(pass.verdict, meta.category)} size={14} color={markColorVar(pass.verdict, meta.category)} />
          <h1 className={s.passName}>{meta.name}</h1>
          <span className={s.passWhen}>
            {t.day} · {t.time} {t.zone}
          </span>
        </div>
      ) : (
        <div key={titleKey} className={titleCls}>
          <div className={s.passTitle}>
            <Mark name={glyphForPass(pass.verdict, meta.category)} size={18} color={markColorVar(pass.verdict, meta.category)} />
            <h1 className={s.passName}>{meta.name}</h1>
          </div>
          <div className={s.placeSub}>
            <b>
              {t.day} · {t.timeS} {t.zone}
            </b>
            {meta.operator ? <span>{meta.operator}</span> : null}
          </div>
        </div>
      )}
      {strip && replayOn ? <ReplayStrip pass={pass} /> : null}
    </div>
  )
}
