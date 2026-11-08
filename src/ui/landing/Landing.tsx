/**
 * <Landing onSubmit/>: phases 'idle' and 'locating'. The hero, the place search, "Use my location",
 * curated example places and a live stats footnote — laid out so the globe stays the hero:
 * a text column on the left of the 12-column grid on desktop, stacked under the globe on phones
 * (where focusing the search lifts the field to the top, clear of the keyboard).
 *
 * Entrance: the window kicker scrambles once, headline lines mask-wipe in on a 60 ms stagger, then
 * the copy, the field and the chips. Leaving (the app starts computing) wipes a clone of the last
 * frame away so the next view is live at once.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useApp } from '@/state/store'
import type { Place } from '@/types'
import { Glyph, Num, Reveal, ScrambleOnce, cx, fmtLat, fmtLon, useExitClone, useIsMobile, useWallSecondSync } from '@/ui/system'
import { useSecondClock } from '@/ui/hud/clock'
import { balancePad } from './balance'
import { EXAMPLE_PLACES, type ExamplePlace } from './places'
import { SearchBox } from './SearchBox'
import { useLookupStats } from './stats'
import { useLocate, type LocateState } from './useLocate'
import { WINDOW_DAYS, windowLabel } from './windowLabel'
import s from './Landing.module.css'

export function Landing({ onSubmit }: { onSubmit: (place: Place) => void }) {
  const phase = useApp((st) => st.phase)
  const mobile = useIsMobile()
  const [searching, setSearching] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const notesRef = useRef<HTMLDivElement>(null)
  const locate = useLocate(onSubmit)
  const locating = phase === 'locating' && locate.state.kind === 'locating'
  const balance = useBalance(columnRef, contentRef, notesRef, !mobile)

  const submit = (p: Place) => {
    if (locate.state.kind === 'locating') locate.cancel()
    locate.dismiss()
    onSubmit(p)
  }

  useExitClone(rootRef, {
    keyframes: [
      { clipPath: 'inset(0 0 0 0)', opacity: 1 },
      { clipPath: 'inset(0 0 100% 0)', opacity: 0.6 },
    ],
    duration: 560,
    easing: 'cubic-bezier(.6, 0, .2, 1)',
  })

  return (
    <div
      ref={rootRef}
      className={s.landing}
      data-searching={mobile && searching ? 'true' : undefined}
      data-note={locate.state.kind !== 'idle' ? 'true' : undefined}
    >
      <section ref={columnRef} className={s.column} style={balance} aria-labelledby="landing-headline">
        <div ref={contentRef} className={s.content}>
          <Kicker />

          <h1 id="landing-headline" className={s.headline}>
            <Reveal as="span" className={s.hl} delay={140}>
              Something
            </Reveal>
            <Reveal as="span" className={s.hl} delay={200}>
              photographed
            </Reveal>
            <Reveal as="span" className={s.hl} delay={260}>
              <em className={s.serif}>you</em> this week.
            </Reveal>
          </h1>

          <Reveal as="p" className={s.sub} delay={420} duration={720}>
            Enter any place on Earth. See every satellite that passed over it in the last {WINDOW_DAYS}&nbsp;days, and the actual
            pictures they took.
          </Reveal>

          <div className={cx(s.searchBlock, s.rise)} style={{ animationDelay: '540ms' }}>
            <SearchBox
              onSubmit={submit}
              onFocusChange={(focused) => {
                setSearching(focused)
                // Turning to the search is moving on from a location fault.
                if (focused) locate.dismiss()
              }}
              statusOverride={locate.state.kind === 'locating' ? <LocatingStatus state={locate.state} /> : undefined}
              idleTrailing={
                locating ? (
                  <button
                    type="button"
                    className={s.locateInline}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={locate.cancel}
                    aria-label="Cancel locating"
                  >
                    Cancel
                  </button>
                ) : (
                  // The visible label is the accessible name (one of the two spans is display: none).
                  <button type="button" className={s.locateInline} onPointerDown={(e) => e.preventDefault()} onClick={locate.start}>
                    <Glyph name="locate" size={14} />
                    <span className={s.locateLabel}>Use my location</span>
                    <span className={s.locateLabelShort}>Locate me</span>
                  </button>
                )
              }
            />
            <div ref={notesRef} className={s.notes}>
              <LocateNotes state={locate.state} onDismiss={locate.dismiss} />
            </div>
          </div>

          <Examples onPick={submit} disabled={locating} />
          {/* A nicety: it steps aside while a locate note needs the room. */}
          <StatsLine hidden={locate.state.kind !== 'idle'} />
        </div>
      </section>
    </div>
  )
}

/**
 * Desktop: the column is vertically centred, so a note under the field would move the whole hero by
 * half the height it adds (or, where the note replaces the chips, removes). Padding the column by
 * that difference cancels it — the headline stays put and the change happens below it — as far as
 * the free space allows. The difference is measured against the last note-free height.
 */
function useBalance(
  columnRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  noteRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): CSSProperties | undefined {
  const [pad, setPad] = useState(0)
  const baseH = useRef<number | null>(null)
  useLayoutEffect(() => {
    const column = columnRef.current
    const content = contentRef.current
    const note = noteRef.current
    if (!enabled || !column || !content || !note || typeof ResizeObserver === 'undefined') {
      setPad(0)
      return
    }
    const measure = () => {
      const contentH = content.offsetHeight
      const noteH = note.offsetHeight
      if (noteH === 0) baseH.current = contentH
      setPad(balancePad(column.clientHeight, contentH, baseH.current, noteH))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(column)
    ro.observe(content)
    ro.observe(note)
    return () => ro.disconnect()
  }, [columnRef, contentRef, noteRef, enabled])
  return pad > 0 ? { paddingTop: pad } : pad < 0 ? { paddingBottom: -pad } : undefined
}

/** "── LAST 7 DAYS · 01 NOV → 08 NOV 2026 UTC" — the exact window "this week" means. */
function Kicker() {
  // Live: a page left open past midnight UTC shows the window a search would actually use.
  const now = useSecondClock()
  return (
    <Reveal axis="x" duration={600} className={s.kicker}>
      <span className={s.kickerRule} aria-hidden />
      <span className={s.kickerIdx}>Last {WINDOW_DAYS} days</span>
      <span className={s.kickerSep} aria-hidden>
        ·
      </span>
      <ScrambleOnce text={windowLabel(now)} delay={200} />
    </Reveal>
  )
}

/** Under the field: what happens to your position while locating, or why it failed. */
function LocateNotes({ state, onDismiss }: { state: LocateState; onDismiss: () => void }) {
  if (state.kind === 'locating')
    return <p className={s.footnote}>Your position goes to the Photon geocoder to name the place. We store only a ~10&nbsp;km cell.</p>
  if (state.kind === 'error')
    return (
      <p className={s.error} role="alert">
        <span className={s.errorLabel}>Location</span>
        <span className={s.errorText}>{state.message}</span>
        <button type="button" className={s.errorClose} onClick={onDismiss} aria-label="Dismiss">
          <Glyph name="close" size={12} />
        </button>
      </p>
    )
  return null
}

function LocatingStatus({ state }: { state: Extract<LocateState, { kind: 'locating' }> }) {
  useSecondClock() // re-render each second for the elapsed readout
  const ref = useRef<HTMLSpanElement>(null)
  useWallSecondSync(ref)
  const secs = Math.max(0, (performance.now() - state.t0) / 1000)
  return (
    <span ref={ref} className={s.locStatus}>
      <span className={s.locDot} aria-hidden />
      {state.step === 'position' ? 'Requesting position' : 'Naming the place'}
      <span className={s.locTime}>{secs.toFixed(0).padStart(2, '0')} S</span>
    </span>
  )
}

function Examples({ onPick, disabled }: { onPick: (p: Place) => void; disabled?: boolean }) {
  const [hover, setHover] = useState<ExamplePlace | null>(null)
  return (
    // A CSS rise (fill: backwards) rather than <Reveal>: the block's delay lives in CSS with the field's.
    <div className={cx(s.examples, s.rise)} style={{ animationDelay: '680ms' }}>
      {/* Label left, live detail right: the same row structure as the field's "01 / Place" line. */}
      <div className={s.examplesHead}>
        <span>
          <span className={s.exIdx}>02</span> / Or try
        </span>
        <span className={s.exHint} aria-hidden>
          {hover ? (
            <>
              <span className={s.exCoord}>
                {fmtLat(hover.lat, 4)} {fmtLon(hover.lon, 4)}
              </span>
              <span className={s.exSep}>·</span>
              {hover.sublabel}
            </>
          ) : null}
        </span>
      </div>
      <ul className={s.chips} onPointerLeave={() => setHover(null)}>
        {EXAMPLE_PLACES.map((p) => (
          <li key={p.chip}>
            <button
              type="button"
              className={s.chip}
              disabled={disabled}
              onClick={() => onPick(p)}
              onPointerEnter={() => setHover(p)}
              onFocus={() => setHover(p)}
              onBlur={() => setHover(null)}
              aria-label={`${p.label}, ${p.sublabel}`}
            >
              {p.chip}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StatsLine({ hidden }: { hidden?: boolean }) {
  const stats = useLookupStats()
  if (!stats) return null
  return (
    <p className={s.stats} hidden={hidden}>
      <Num value={stats.total} className={s.statNum} /> {stats.total === 1 ? 'place' : 'places'} checked
      <span className={s.exSep}>·</span>
      <Num value={stats.last24h} delay={120} className={s.statNum} /> in the last 24&nbsp;h
    </p>
  )
}
