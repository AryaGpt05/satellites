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
import { useRef, useState } from 'react'
import { useApp } from '@/state/store'
import type { Place } from '@/types'
import { Glyph, Num, Reveal, ScrambleOnce, cx, fmtLat, fmtLon, useExitClone, useIsMobile } from '@/ui/system'
import { EXAMPLE_PLACES, type ExamplePlace } from './places'
import { SearchBox } from './SearchBox'
import { useLookupStats } from './stats'
import { useLocate, type LocateState } from './useLocate'
import { WINDOW_DAYS, windowLabel } from './windowLabel'
import { useSecondClock } from '@/ui/hud/clock'
import s from './Landing.module.css'

export function Landing({ onSubmit }: { onSubmit: (place: Place) => void }) {
  const phase = useApp((st) => st.phase)
  const mobile = useIsMobile()
  const [searching, setSearching] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const locate = useLocate(onSubmit)
  const locating = phase === 'locating' && locate.state.kind === 'locating'

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
    <div ref={rootRef} className={s.landing} data-searching={mobile && searching ? 'true' : undefined}>
      <section className={s.column} aria-labelledby="landing-headline">
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
            onFocusChange={setSearching}
            statusOverride={locate.state.kind === 'locating' ? <LocatingStatus state={locate.state} /> : undefined}
            idleTrailing={
              locating ? (
                <button type="button" className={s.locateInline} onPointerDown={(e) => e.preventDefault()} onClick={locate.cancel}>
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  className={s.locateInline}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={locate.start}
                  aria-label="Use my location"
                >
                  <Glyph name="locate" size={14} />
                  <span className={s.locateLabel}>Use my location</span>
                </button>
              )
            }
          />
          <LocateNotes state={locate.state} onDismiss={locate.dismiss} />
        </div>

        <Examples onPick={submit} disabled={locating} />
        <StatsLine />
      </section>
    </div>
  )
}

/** "── LAST 7 DAYS · 01 NOV → 08 NOV 2026 UTC" — the exact window "this week" means. */
function Kicker() {
  const [now] = useState(() => Date.now())
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
    return <p className={s.footnote}>Your position goes to the Photon geocoder to name the place. We keep only a ~10&nbsp;km cell.</p>
  if (state.kind === 'error')
    return (
      <p className={s.error} role="alert">
        <span>{state.message}</span>
        <button type="button" className={s.errorClose} onClick={onDismiss} aria-label="Dismiss">
          <Glyph name="close" size={12} />
        </button>
      </p>
    )
  return null
}

function LocatingStatus({ state }: { state: Extract<LocateState, { kind: 'locating' }> }) {
  useSecondClock() // re-render each second for the elapsed readout
  const secs = Math.max(0, (performance.now() - state.t0) / 1000)
  return (
    <span className={s.locStatus}>
      <span className={s.locDot} aria-hidden />
      {state.step === 'position' ? 'Requesting position' : 'Naming the place'}
      <span className={s.locTime}>{secs.toFixed(0).padStart(2, '0')} S</span>
    </span>
  )
}

function Examples({ onPick, disabled }: { onPick: (p: Place) => void; disabled?: boolean }) {
  const [hover, setHover] = useState<ExamplePlace | null>(null)
  return (
    // CSS rise (not <Reveal>): its clip must not outlive the entrance, or the phone chip row is cut off.
    <div className={cx(s.examples, s.rise)} style={{ animationDelay: '680ms' }}>
      <div className={s.examplesHead}>
        <span className={s.exIdx}>02</span> / Or try
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
      <p className={s.exHint} aria-hidden>
        {hover ? (
          <>
            <span className={s.exCoord}>
              {fmtLat(hover.lat, 4)} {fmtLon(hover.lon, 4)}
            </span>
            <span className={s.exSep}>·</span>
            {hover.sublabel}
          </>
        ) : (
          ' '
        )}
      </p>
    </div>
  )
}

function StatsLine() {
  const stats = useLookupStats()
  if (!stats) return null
  return (
    <p className={s.stats}>
      <Num value={stats.total} className={s.statNum} /> places checked so far
      <span className={s.exSep}>·</span>
      <Num value={stats.last24h} delay={120} className={s.statNum} /> in the last 24&nbsp;h
    </p>
  )
}
