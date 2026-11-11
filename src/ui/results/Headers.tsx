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
 * A share recipient sees a one-line tag above it (R2R10): SHARED WITH YOU · SENTINEL-2C WATCHED WATERLOO.
 */
import { memo, useEffect, useRef, type KeyboardEvent } from 'react'
import { timeZoneAt } from '@/imagery'
import { useApp } from '@/state/store'
import type { Pass, Place } from '@/types'
import { SearchBox } from '@/ui/landing/SearchBox'
import { Glyph, Kbd, LiveDot, ScrambleOnce, cx, fmtLat, fmtLon, useMediaQuery } from '@/ui/system'
import { secs } from './ComputingBody'
import { Mark } from './Mark'
import { useOnce } from './once'
import { ReplayStrip } from './ReplayControls'
import { Headline, MoreLine, countPending } from './Summary'
import { clearPass } from './actions'
import { ONE_LINE_TITLE_QUERY, SHORT_DESK_QUERY } from './shell'
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
  /** Phones: the headline's Share (the week's summary) */
  onShareWeek?: () => void
}

export function OverviewHeader(props: OverviewHeaderProps) {
  const { place, model, computing, mobile, enter, searching } = props
  const tz = model?.tz ?? (place ? timeZoneAt(place.lat, place.lon) : undefined)
  const partial = !computing && !!model && countPending(model.report)
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
        <HeadAction
          mode={computing ? 'cancel' : searching ? 'close' : 'search'}
          // Phones: the search bar below is the way to a new search; the corner keeps only Cancel / Close.
          quietSearch={mobile}
          outlined={!mobile}
          onCancel={props.onCancel}
          onClose={props.onCloseSearch}
          onSearch={props.onOpenSearch ?? props.onBack}
        />
      </div>

      {/* Phones, results: the search bar, where the place row was while computing (so nothing above it moves). */}
      {mobile && !computing && !searching && place && model ? <SearchBar place={place} onOpen={props.onOpenSearch ?? props.onBack} /> : null}

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
          <MoreLine model={model} compact enter={enter} onRetry={props.onRetry} onShare={props.onShareWeek} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * The header's one action: Cancel (computing) · New search (results) · Close (the inline search open). One button
 * whose three labels share a grid cell, so it keeps the width of the longest: switching never moves it, or the row
 * (R3-8: no layout shift at results arrival, New search, a new place).
 */
function HeadAction({
  mode,
  quietSearch = false,
  outlined = false,
  onCancel,
  onClose,
  onSearch,
}: {
  mode: 'cancel' | 'search' | 'close'
  /** Phones: the search mode's label steps aside (the search bar takes that job); the button keeps its box */
  quietSearch?: boolean
  /** Desktop: an outlined button, not a faint label */
  outlined?: boolean
  onCancel: () => void
  onClose: () => void
  onSearch: () => void
}) {
  const label = (m: typeof mode) => cx(s.crumbLabel, mode !== m && s.crumbLabelOff)
  const hidden = quietSearch && mode === 'search'
  return (
    <button
      type="button"
      className={cx(s.crumb, outlined && s.crumbOutlined, hidden && s.crumbHidden)}
      onClick={mode === 'cancel' ? onCancel : mode === 'close' ? onClose : onSearch}
      aria-keyshortcuts="Escape"
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
    >
      <span className={s.crumbLabels}>
        <span className={label('cancel')} aria-hidden={mode !== 'cancel' || undefined}>
          Cancel
        </span>
        <span className={label('search')} aria-hidden={mode !== 'search' || undefined}>
          <Glyph name="search" size={11} />
          New search
        </span>
        <span className={label('close')} aria-hidden={mode !== 'close' || undefined}>
          <Glyph name="close" size={11} />
          Close
        </span>
      </span>
      <span className={s.kbdHover} aria-hidden>
        <Kbd>Esc</Kbd>
      </span>
    </button>
  )
}

/**
 * Phones: the way to a new search, as the first thing in the sheet. It looks like the landing's search field (the
 * same height, glyph and mono line) holding the current place, with "Change" at its end; a tap anywhere opens the
 * inline search with the field focused.
 */
function SearchBar({ place, onOpen }: { place: Place; onOpen: () => void }) {
  return (
    <button type="button" className={s.searchBar} onClick={onOpen} aria-label={`Search another place (now ${place.label})`}>
      <span className={s.searchBarGlyph} aria-hidden>
        <Glyph name="search" size={16} />
      </span>
      <span className={s.searchBarPlace}>{place.label}</span>
      <span className={s.searchBarAction} aria-hidden>
        Change
      </span>
    </button>
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
      <SearchBox onSubmit={submit} autoFocus placeholder="Search another place" />
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
  /** Phones: a new search in one tap (back to the list with the search open) */
  onSearch?: () => void
}

/** Pass header: back, position within the verdict with ‹ ›, the satellite, its local time. */
export function DetailHeader({ model, pass, mobile, onSelect, strip, photo, shared, onSearch }: DetailHeaderProps) {
  const meta = model.meta(pass.norad)
  const lane = model.lanes[pass.verdict].passes
  const index = lane.findIndex((p) => p.id === pass.id)
  const step = (dir: 1 | -1) => {
    const next = stepPass(model.lanes, pass, dir)
    if (next && next.id !== pass.id) onSelect(next)
  }
  const t = model.times(pass)
  // Phones and short laptops: the name and the time on one line (R2R1: the pass photo gets the height).
  const oneLine = useMediaQuery(ONE_LINE_TITLE_QUERY) || mobile
  // Laptops up to 860 px tall (1280×800): the back crumb rides on the title's row, so the pass photo reaches the
  // column's full width (R3-6).
  const inline = useMediaQuery(SHORT_DESK_QUERY) && !mobile
  // The strip shows once the camera has arrived and the scene is replaying or held (MOB-16).
  // Once shown in this header, it stays while the scene is in replay time: a quiet selection's short camera
  // move never blinks it off and on (A1).
  const live = useApp((st) => st.timeMode === 'live')
  const flying = useApp((st) => st.cameraFlight.flying)
  const stripSeen = useRef(false)
  if (live) stripSeen.current = false
  else if (!flying) stripSeen.current = true
  const replayOn = !live && (!flying || stripSeen.current)
  // A quiet selection (a swipe) changes the title in place: a 160 ms fade of the words, never the header.
  const firstId = useRef(pass.id)
  const titleKey = photo ? pass.id : 'one'
  const titleCls = photo && pass.id !== firstId.current ? s.titleIn : undefined
  const stepper = (
    <span className={cx(s.stepper, photo && s.stepperOff)} aria-hidden={photo || undefined}>
      <span className={s.position} aria-label={`Pass ${index + 1} of ${lane.length} of this kind`}>
        {index + 1}
        {/* A big lane on a narrow phone (V1: "1350 / 1362" crowded the row): the position alone. */}
        <span className={cx(lane.length >= 1000 && s.positionTotalLong)}> / {lane.length}</span>
      </span>
      <button type="button" className={s.stepBtn} onClick={() => step(-1)} disabled={index <= 0} aria-label="Previous pass of this kind" aria-keyshortcuts="ArrowLeft" title="Previous (←)">
        <Mark name="chevron-left" size={12} />
      </button>
      <button type="button" className={s.stepBtn} onClick={() => step(1)} disabled={index >= lane.length - 1} aria-label="Next pass of this kind" aria-keyshortcuts="ArrowRight" title="Next (→)">
        <Mark name="chevron-right" size={12} />
      </button>
    </span>
  )
  if (inline)
    return (
      <div className={s.detailHead}>
        {shared ? (
          <p className={s.sharedTag}>
            <span className={s.sharedDot} aria-hidden />
            <span className={s.sharedText}>
              Shared with you · {shared.sat} watched {shared.place}
            </span>
          </p>
        ) : null}
        <div className={cx(s.headTop, s.headInline)}>
          <button type="button" className={cx(s.crumb, s.crumbIcon)} onClick={clearPass} aria-label="All passes" title="All passes (Esc)" aria-keyshortcuts="Escape">
            <Glyph name="arrow-left" size={12} />
          </button>
          <div key={titleKey} className={cx(s.passTitle, s.passTitleCompact, s.passTitleInline, titleCls)}>
            <Mark name={glyphForPass(pass.verdict, meta.category)} size={14} color={markColorVar(pass.verdict, meta.category)} />
            <h1 className={s.passName}>{meta.name}</h1>
            <span className={s.passWhen}>
              {t.day} · {t.time} {t.zone}
            </span>
          </div>
          {photo ? null : stepper}
        </div>
      </div>
    )
  return (
    <div className={s.detailHead}>
      {shared ? (
        <p className={s.sharedTag}>
          <span className={s.sharedDot} aria-hidden />
          <span className={s.sharedText}>
            Shared with you · {shared.sat} watched {shared.place}
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
        <span className={s.headTopEnd}>
          {stepper}
          {mobile && onSearch ? (
            <button type="button" className={s.searchIcon} onClick={onSearch} aria-label="Search another place" title="Search another place">
              <Glyph name="search" size={14} />
            </button>
          ) : null}
        </span>
      </div>
      {oneLine ? (
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
      {/* Phones: the strip's row is reserved from the start (no header height change, so no layout shift, when the
          camera lands); it fades in once the scene is replaying or held there (MOB-16). */}
      {strip ? (
        <div className={cx(s.stripSlot, replayOn && s.stripOn)} inert={!replayOn || undefined}>
          <ReplayStrip pass={pass} />
        </div>
      ) : null}
    </div>
  )
}
