/**
 * <Landing onSubmit enterDelay/>: phases 'idle' and 'locating'. The hero, the place search, "Use my
 * location", curated example places and a live stats footnote, laid out so the globe stays the hero:
 *
 *   wide            a text column on the left of the 12-column grid; the globe frames to its right
 *   stacked         a compact ink panel in the bottom ~47%; the whole globe sits above it (decision 4).
 *                   Focusing the search lifts the field to the top, clear of the keyboard.
 *   short landscape copy in the right half, the globe on the left
 *
 * It publishes what it covers (store.uiInsets) so the camera frames the globe in what is left.
 *
 * Entrance (once per session): after `enterDelay` (the boot curtain), the window kicker scrambles once,
 * headline lines mask-wipe in on a 60 ms stagger, then the copy, the field and the chips. Later visits
 * (back from results) get one short rise of the whole column. Leaving (the app starts computing) plays
 * on a clone of the last frame, so the next view is live at once.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { DUR, EASE } from '@/lib/ease'
import { SHORT_LANDSCAPE_QUERY, isStacked } from '@/lib/layout'
import { useApp, type Phase } from '@/state/store'
import type { Place } from '@/types'
import {
  Glyph,
  Num,
  Reveal,
  ScrambleOnce,
  cx,
  fmtLat,
  fmtLon,
  insertFrozenClone,
  animateOut,
  prefersReducedMotion,
  useExitClone,
  useIsMobile,
  useMediaQuery,
  useWallSecondSync,
} from '@/ui/system'
import { useSecondClock, useSecondDerived } from '@/ui/hud/clock'
import { balancePad } from './balance'
import { EXAMPLE_PLACES, type ExamplePlace } from './places'
import { SearchBox } from './SearchBox'
import { useLookupStats } from './stats'
import { useLocate, type LocateState } from './useLocate'
import { WINDOW_DAYS, windowLabel } from './windowLabel'
import s from './Landing.module.css'

/**
 * The full entrance plays once per session, and only straight out of the boot screen. Every other
 * mount (back from results, an error, or a deep link's first "New search") gets the short rise: someone
 * who pressed Esc wants the field now, not a 1.7 s title sequence.
 */
let seen = false
/** The phase the app was in before the current one (tracked from module load, before any landing mounts). */
let previousPhase: Phase = useApp.getState().phase
useApp.subscribe((st, prev) => {
  if (st.phase !== prev.phase) previousPhase = prev.phase
})

/** Stacked: the ink panel starts this far above the column's first line (Landing.module.css .column::before). */
const PANEL_PAD_TOP = 22
/** Wide: the globe's point cloud keeps this much air from the end of the text. */
const TEXT_CLEAR = 24

interface LandingProps {
  onSubmit: (place: Place) => void
  /** ms to wait before the entrance (after the boot curtain) */
  enterDelay?: number
}

/**
 * Memoised on `enterDelay` only: the app passes a fresh `onSubmit` on every render, and re-rendering
 * the hero for that would re-render every line of it. The latest callback is always the one called.
 */
export const Landing = memo(LandingImpl, (a, b) => a.enterDelay === b.enterDelay)

function LandingImpl({ onSubmit: onSubmitProp, enterDelay = 0 }: LandingProps) {
  const submitRef = useRef(onSubmitProp)
  submitRef.current = onSubmitProp
  const onSubmit = useCallback((p: Place) => submitRef.current(p), [])
  const phase = useApp((st) => st.phase)
  const stacked = useIsMobile()
  const shortLandscape = useMediaQuery(SHORT_LANDSCAPE_QUERY)
  // Search mode (the field lifted to the top) exists where the on-screen keyboard would cover it.
  const liftable = stacked || shortLandscape
  const [searching, setSearching] = useState(false)
  const searchingRef = useRef(false)
  searchingRef.current = searching
  const [first] = useState(() => !seen && previousPhase === 'boot')
  const [entered, setEntered] = useState(() => !first)
  const delay = prefersReducedMotion() ? 0 : enterDelay
  const rootRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const notesRef = useRef<HTMLDivElement>(null)
  const locate = useLocate(onSubmit)
  const locating = phase === 'locating' && locate.state.kind === 'locating'
  const balance = useBalance(columnRef, contentRef, notesRef, !liftable)

  // Once per session; the UI entrance holds heavy GPU work (texture uploads) until it has played.
  useEffect(() => {
    seen = true
    useApp.getState().holdMotion(delay + (first ? 1600 : DUR.md))
    if (!first) return
    const id = window.setTimeout(() => setEntered(true), delay + 1700)
    return () => window.clearTimeout(id)
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useInsets(columnRef, contentRef, searchingRef, [stacked, shortLandscape, searching, locate.state.kind])

  const submit = (p: Place) => {
    if (locate.state.kind === 'locating') locate.cancel()
    locate.dismiss()
    onSubmit(p)
  }

  // ── search mode (stacked) ──────────────────────────────────────────────────────────────
  // FLIP: the field glides from where it was to where it goes (320 ms ease-out); entering, the hero
  // copy fades out on a frozen copy (160 ms); leaving, it fades back in.
  const flipFrom = useRef<number | null>(null)
  const enterSearch = () => {
    if (!liftable || searchingRef.current) return
    flipFrom.current = searchRef.current?.getBoundingClientRect().top ?? null
    const column = columnRef.current
    if (column && !prefersReducedMotion()) {
      const ghost = insertFrozenClone(column, (c) => {
        c.dataset.ghost = ''
        c.querySelector<HTMLElement>('[data-search-block]')?.style.setProperty('visibility', 'hidden')
      })
      animateOut(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE.inOut })
    }
    setEntered(true)
    searchingRef.current = true
    flushSync(() => setSearching(true))
  }
  const leaveSearch = () => {
    if (!searchingRef.current) return
    flipFrom.current = searchRef.current?.getBoundingClientRect().top ?? null
    searchingRef.current = false
    setSearching(false)
  }
  useLayoutEffect(() => {
    const from = flipFrom.current
    flipFrom.current = null
    const block = searchRef.current
    if (from === null || !block || prefersReducedMotion()) return
    const dy = from - block.getBoundingClientRect().top
    if (Math.abs(dy) > 1) {
      block.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 320, easing: EASE.out })
    }
    if (!searching) {
      // Back from search mode: the copy and its panel fade back in around the returning field. The copy
      // waits until the field has nearly landed (ease-out: ~90% of the way at 180 ms) and is still faint
      // as it settles, so the line never glides down through legible words.
      const column = columnRef.current
      column?.querySelectorAll<HTMLElement>('[data-hero-copy]').forEach((el) => {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 180, easing: EASE.out, fill: 'backwards' })
      })
      try {
        column?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: EASE.out, pseudoElement: '::before' })
      } catch {
        /* pseudo-element animation unsupported: the panel just appears */
      }
    }
  }, [searching])

  // While searching, cancel any pan the browser applied to bring the field into view (iOS): it has
  // already been moved to the top, and a residual pan would push it off-screen.
  useEffect(() => {
    const vv = window.visualViewport
    if (!searching || !vv) return
    const onScroll = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0 || vv.offsetTop > 0) window.scrollTo(0, 0)
    }
    vv.addEventListener('scroll', onScroll)
    return () => vv.removeEventListener('scroll', onScroll)
  }, [searching])

  // Leaving for 'computing': the open suggestion list folds away first, then the hero exits.
  useExitClone(rootRef, {
    keyframes: stacked
      ? [
          { opacity: 1, transform: 'translateY(0)' },
          { opacity: 0, transform: 'translateY(8px)' },
        ]
      : [
          { clipPath: 'inset(0 0 0 0)', opacity: 1 },
          { clipPath: 'inset(0 0 100% 0)', opacity: 0.6 },
        ],
    duration: stacked ? DUR.exit : 360,
    easing: EASE.inOut,
    onStart: (clone, reduced) => {
      if (reduced) return
      clone.querySelector<HTMLElement>('[data-suggestions]')?.animate([{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(0 0 100% 0)' }], {
        duration: 120,
        easing: EASE.inOut,
        fill: 'forwards',
      })
    },
  })

  const rootStyle = { '--enter-delay': `${delay}ms` } as CSSProperties

  return (
    <div
      ref={rootRef}
      className={s.landing}
      style={rootStyle}
      data-searching={liftable && searching ? 'true' : undefined}
      data-note={locate.state.kind !== 'idle' ? 'true' : undefined}
      data-entered={entered ? '' : undefined}
      data-return={first ? undefined : ''}
    >
      <section ref={columnRef} className={s.column} style={balance} aria-labelledby="landing-headline">
        <div ref={contentRef} className={s.content}>
          <Kicker delay={delay} skip={!first} />

          <h1 id="landing-headline" className={s.headline} data-hero-copy>
            <Reveal as="span" className={s.hl} delay={delay + 140} skip={!first}>
              Something
            </Reveal>
            <Reveal as="span" className={s.hl} delay={delay + 200} skip={!first}>
              photographed
            </Reveal>
            <Reveal as="span" className={s.hl} delay={delay + 260} skip={!first}>
              <em className={s.serif}>you</em> this week.
            </Reveal>
          </h1>

          <Reveal as="p" className={s.sub} delay={delay + 420} duration={720} skip={!first}>
            <span data-hero-copy>
              Enter any place on Earth. See every satellite that passed over it in the last {WINDOW_DAYS}&nbsp;days, and the actual
              pictures they took.
            </span>
          </Reveal>

          <div ref={searchRef} className={cx(s.searchBlock, s.rise, s.riseSearch)} data-search-block>
            <SearchBox
              onSubmit={submit}
              metaHidden={liftable && !searching && locate.state.kind === 'idle'}
              onBeforeFocus={liftable ? enterSearch : undefined}
              onFocusChange={(focused) => {
                if (focused) {
                  enterSearch()
                  // Turning to the search is moving on from a location fault.
                  locate.dismiss()
                } else leaveSearch()
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
                  // The visible label is the accessible name: "Locate me" on phones; where the button is
                  // icon-only (≤ 400 px) the long form is visually hidden but still names it.
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
 * Publish what the landing covers so the camera frames the globe in the rest (store.uiInsets):
 *   stacked          the ink panel: bottom = from its top edge down
 *   short landscape  the copy column on the right
 *   wide             the text on the left: left = the end of the longest line + TEXT_CLEAR
 * Not while searching: the camera must not move while you type.
 */
function useInsets(
  columnRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  searchingRef: RefObject<boolean>,
  deps: unknown[],
) {
  useLayoutEffect(() => {
    const column = columnRef.current
    const content = contentRef.current
    if (!column || !content) return
    const set = useApp.getState().setUiInsets
    const shortLandscape = () => window.matchMedia?.(SHORT_LANDSCAPE_QUERY).matches ?? false
    const publish = () => {
      if (searchingRef.current) return
      const W = window.innerWidth
      const H = window.innerHeight
      if (shortLandscape()) {
        // offsetLeft: layout position, ignoring the entrance transforms.
        set({ right: Math.max(0, W - column.offsetLeft + TEXT_CLEAR), bottom: 0, left: 0 })
      } else if (isStacked(W, H)) {
        set({ bottom: Math.max(0, H - (column.offsetTop - PANEL_PAD_TOP)), left: 0, right: 0 })
      } else {
        let right = 0
        for (const el of content.children) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) right = Math.max(right, r.right)
        }
        set({ left: right > 0 ? right + TEXT_CLEAR : column.getBoundingClientRect().right + TEXT_CLEAR, right: 0, bottom: 0 })
      }
    }
    publish()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(publish)
    ro.observe(column)
    ro.observe(content)
    window.addEventListener('resize', publish)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', publish)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
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
function Kicker({ delay, skip }: { delay: number; skip: boolean }) {
  // Live: a page left open past midnight UTC shows the window a search would actually use. The label
  // re-renders only when the day changes, not every second.
  const label = useSecondDerived(windowLabel)
  return (
    <Reveal axis="x" duration={600} delay={delay} skip={skip} className={s.kicker}>
      <span className={s.kickerRule} aria-hidden />
      <span className={s.kickerIdx}>Last {WINDOW_DAYS} days</span>
      <span className={s.kickerSep} aria-hidden>
        ·
      </span>
      {skip ? <span>{label}</span> : <ScrambleOnce text={label} delay={delay + 200} />}
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
      <span className={s.locDot} aria-hidden data-blink />
      {state.step === 'position' ? 'Requesting position' : 'Naming the place'}
      <span className={s.locTime}>{secs.toFixed(0).padStart(2, '0')} S</span>
    </span>
  )
}

function Examples({ onPick, disabled }: { onPick: (p: Place) => void; disabled?: boolean }) {
  const [hover, setHover] = useState<ExamplePlace | null>(null)
  // Swipeable row (stacked): the edge fade that says "more" lifts once the row is scrolled to its end.
  const listRef = useRef<HTMLUListElement>(null)
  const markEnd = () => {
    const ul = listRef.current
    if (!ul) return
    const end = ul.scrollWidth - ul.clientWidth - ul.scrollLeft <= 2
    if (end) ul.dataset.end = ''
    else delete ul.dataset.end
  }
  useLayoutEffect(() => {
    const ul = listRef.current
    if (!ul || typeof ResizeObserver === 'undefined') return
    markEnd()
    const ro = new ResizeObserver(markEnd)
    ro.observe(ul)
    return () => ro.disconnect()
  }, [])
  return (
    // A CSS rise (fill: backwards) rather than <Reveal>: the block's delay lives in CSS with the field's.
    <div className={cx(s.examples, s.rise, s.riseExamples)} data-hero-copy>
      {/* Wide: label left, live detail right, the same row structure as the field's "01 / Place" line. */}
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
      <ul ref={listRef} className={s.chips} aria-label="Example places" onScroll={markEnd} onPointerLeave={() => setHover(null)}>
        {/* Stacked: the label leads the swipeable row instead of taking a line of its own. */}
        <li className={s.chipLead} aria-hidden>
          Or try
        </li>
        {EXAMPLE_PLACES.map((p) => (
          <li key={p.chip}>
            <button
              type="button"
              className={s.chip}
              disabled={disabled}
              onClick={() => onPick(p)}
              onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(p)}
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
    <p className={s.stats} hidden={hidden} data-hero-copy>
      {/* counts settle from 90% (never caught at 0 in a screen recording) */}
      <Num value={stats.total} from={Math.round(stats.total * 0.9)} className={s.statNum} />{' '}
      {stats.total === 1 ? 'place' : 'places'} checked
      <span className={s.exSep}>·</span>
      <Num value={stats.last24h} from={Math.round(stats.last24h * 0.9)} delay={120} className={s.statNum} /> in the last 24&nbsp;h
    </p>
  )
}
