/**
 * <ResultsView/>: the ONE results panel, from computing through results to a pass (decision #10).
 * Mounted for phase 'computing' and 'results'; it keys off the phase, not off the report.
 *
 *   desktop  right-docked panel (Sheet). While computing it is as tall as its readout; when results
 *            land it grows to the full dock above the timeline strip (beside it on short screens).
 *   phones   bottom sheet with content-measured snaps: computing = the readout; overview = header +
 *            best-look hero (the peek); a pass = flight (header + footer), then image.
 *
 * Contents swap in two beats (old out 160 ms, new in 240 ms), never as a page cut. Overview:
 * 01 / SUMMARY (headline, best look, readouts) · 02 / PASSES · 03 / WATCHED CONTINUOUSLY, and the
 * 04 / TIMELINE strip. A pass: its capture (pushbroom reveal), readouts, 01 / GEOMETRY, 02 / REPLAY,
 * with Share / Replay in the footer.
 *
 * Keys: ←/→ step through passes (same verdict as the selection), Space plays/pauses the replay.
 * Esc is NOT handled here (except inside the inline search field): the app shell owns it.
 */
import { startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { timeZoneAt } from '@/imagery'
import { SHORT_LANDSCAPE_QUERY } from '@/lib/layout'
import { useApp } from '@/state/store'
import type { Pass, Place } from '@/types'
import { ShareSheet } from '@/ui/share'
import { Button, Glyph, Rule, Sheet, cx, useIsMobile, useMediaQuery, useReducedMotion } from '@/ui/system'
import { BestLook } from './BestLook'
import { ComputingBody } from './ComputingBody'
import { GeoWatchers } from './GeoWatchers'
import { DetailHeader, OverviewHeader, rememberPlace } from './Headers'
import { PassDetail } from './PassDetail'
import { PassList } from './PassList'
import { Headline, MoreLine, Notes, Verdicts, enterStyle } from './Summary'
import { Timeline } from './Timeline'
import { clearPass, focusPass, startReplay, togglePlay } from './actions'
import { isClouded } from './lib/bestLook'
import { captureFor } from './lib/captures'
import { replayWindow } from './lib/replay'
import { stepPass } from './lib/timeline'
import { useResultsModel, type ResultsModel } from './model'
import { useOnce } from './once'
import { exitTimeline, lastShellUnmount, publishSheetInset, useAnimatedHeight, useInsets, useSheetGeometry, useShellExit, useStagedKey } from './shell'
import s from './results.module.css'

export interface ResultsViewProps {
  /** Back to search. Defaults to store.reset(); the app passes its controller's reset (aborts work, clears the URL). */
  onBack?: () => void
  /** Re-run the same place (e.g. after an archive outage) */
  onRetry?: () => void
  /** Search another place inline from the results header */
  onSearch?: (place: Place) => void
}

/** Phone snaps that are fractions of the viewport (the measured ones are px). */
const MID = 0.62
const TOP = 0.92
/** Desktop dock height the computing panel starts from when the panel is remounted at results. */
let lastComputingH = 0

export function ResultsView({ onBack, onRetry, onSearch }: ResultsViewProps) {
  const phase = useApp((st) => st.phase)
  const place = useApp((st) => st.place)
  const shared = useApp((st) => st.shared)
  // PERF-03: the report lands in a deferred render, so the arrival never blocks a frame of the flight.
  const report = useDeferredValue(useApp((st) => st.report))
  const selectedId = useApp((st) => st.selectedPassId)
  const mobile = useIsMobile()
  const shortLandscape = useMediaQuery(SHORT_LANDSCAPE_QUERY) && !mobile
  const reduced = useReducedMotion()
  const computing = phase !== 'results' || !report
  const liveModel = useResultsModel(computing ? undefined : report)
  // While the old overview fades out for a new computing run, it keeps rendering its last model.
  const lastModel = useRef(liveModel)
  if (liveModel) lastModel.current = liveModel
  const model = liveModel
  const back = onBack ?? (() => useApp.getState().reset())

  const bodyRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement | null>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const listScroll = useRef(0)
  const [sharing, setSharing] = useState<Pass | null>(null)
  const [searching, setSearching] = useState(false)
  const [inviteClosed, setInviteClosed] = useState(false)
  const [snap, setSnap] = useState(0)
  const overviewSnap = useRef(0)
  // When computing started (T+ readout), reset for each new place.
  const [t0, setT0] = useState(() => performance.now())
  const placeKey = place ? `${place.lat},${place.lon}` : ''
  useEffect(() => setT0(performance.now()), [placeKey])
  const placeTz = useMemo(() => (place ? timeZoneAt(place.lat, place.lon) : undefined), [placeKey])

  // Continuity across a remount (the current app mounts a fresh view at the computing → results
  // switch): no second entrance for the panel.
  const [continued] = useState(() => performance.now() - lastShellUnmount.at < 400 && lastShellUnmount.phase === 'results')

  useLayoutEffect(() => {
    sectionRef.current = (bodyRef.current?.parentElement as HTMLElement | null) ?? null
  })

  // ── what is shown ──────────────────────────────────────────────────────────────────────
  const selectedValid = !!selectedId && !!model?.passById.has(selectedId)
  const viewKey = computing ? 'computing' : selectedValid ? `pass:${selectedId}` : 'overview'
  // Remember where the list was before leaving it.
  useEffect(() => {
    if (viewKey.startsWith('pass:') && bodyRef.current && !bodyRef.current.querySelector('[data-detail-root]')) listScroll.current = bodyRef.current.scrollTop
  }, [viewKey])
  const staged = useStagedKey(viewKey)
  const shownModel = lastModel.current
  const shownPass = staged.shown.startsWith('pass:') ? shownModel?.passById.get(staged.shown.slice(5)) : undefined
  const shownKey = shownPass ? staged.shown : staged.shown === 'computing' && !computing ? 'computing' : staged.shown.startsWith('pass:') ? 'overview' : staged.shown
  const headerKeyOf = (k: string) => (k.startsWith('pass:') ? k : 'overview')
  const headerChanging = headerKeyOf(viewKey) !== headerKeyOf(staged.shown)
  const headerEntering = staged.stage === 'in' && headerKeyOf(staged.prev) !== headerKeyOf(staged.shown)
  const prevPass = staged.prev.startsWith('pass:') ? shownModel?.passById.get(staged.prev.slice(5)) : undefined
  const dir = !shownPass ? -1 : prevPass && prevPass.tClosest > shownPass.tClosest ? -1 : 1
  const handoff = staged.prev === 'computing' && shownKey === 'overview'

  // Scroll: a pass opens at the top; the list comes back where it was. While the new content is
  // still at opacity ~0 (first frame of its entrance), so the jump is never seen.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const target = shownKey === 'overview' ? listScroll.current : 0
    const id = requestAnimationFrame(() => {
      body.scrollTop = target
    })
    return () => cancelAnimationFrame(id)
  }, [shownKey])

  // The results handoff: let the globe keep its GPU work for after the entrance.
  useEffect(() => {
    if (handoff) useApp.getState().holdMotion(900)
  }, [handoff])

  // Staging (PERF-03): the list, the geostationary frames and the timeline marks mount one frame
  // after the summary and the hero, in a transition. Once per report.
  const reportKey = model ? `${model.report.windowEnd}:${model.report.place.lat},${model.report.place.lon}` : ''
  const [fullFor, setFullFor] = useState('')
  const full = !!reportKey && fullFor === reportKey
  useEffect(() => {
    if (!reportKey || fullFor === reportKey) return
    const id = requestAnimationFrame(() => startTransition(() => setFullFor(reportKey)))
    return () => cancelAnimationFrame(id)
  }, [reportKey, fullFor])

  useEffect(() => {
    if (model) rememberPlace(model.report.place)
  }, [model?.report.place])

  // ── selection ──────────────────────────────────────────────────────────────────────────
  const select = useCallback((p: Pass) => {
    focusPass(p)
  }, [])
  const selected = selectedValid && model ? model.passById.get(selectedId!) : undefined
  useExternalFocus(selectedId, model)
  useReplayGuard(selected, () => mobile && setSnap(1))
  useDeselectCleanup()
  useKeys(model, selected, select, !!sharing || searching)
  const closeShare = useCallback(() => setSharing(null), [])
  // A selection that vanished (report replaced by the final one) falls back to the overview.
  useEffect(() => {
    if (selectedId && model && !model.passById.has(selectedId)) clearPass()
  }, [selectedId, model])

  // ── phone sheet: content-measured snaps and the two-beat pass choreography ─────────────
  const geo = useSheetGeometry(bodyRef, innerRef, mobile, [shownKey, full])
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight
  const snaps = (() => {
    if (!geo) return shownKey === 'computing' ? [0.44, TOP] : [0.42, MID, TOP]
    const pad = geo.pad
    if (shownKey === 'computing') return [Math.min(vh * 0.8, geo.top + pad + geo.content + 18), TOP]
    if (shownKey === 'overview') {
      const peek = geo.peekEnd !== undefined ? geo.top + pad + geo.peekEnd + 12 : vh * 0.36
      return [Math.min(peek, vh * (MID - 0.02)), MID, TOP]
    }
    const flight = geo.top + geo.foot + 2
    const image = geo.imageEnd !== undefined ? geo.top + pad + geo.imageEnd + 12 + geo.foot : vh * 0.7
    return [Math.min(flight, vh * 0.4), Math.max(Math.min(image, vh * (TOP - 0.02)), Math.min(flight, vh * 0.4) + 40), TOP]
  })()

  // Phase / view changes pick the snap.
  useEffect(() => {
    if (!mobile) return
    if (viewKey === 'computing') setSnap(0)
    else if (viewKey === 'overview') setSnap(overviewSnap.current)
  }, [viewKey, mobile])
  // A new place opens on the peek again.
  useEffect(() => {
    overviewSnap.current = 0
  }, [placeKey])

  // A pass on phones: flight first (sheet low, the camera and swath visible), then the image.
  useEffect(() => {
    if (!mobile || !selectedId) return
    if (reduced) {
      setSnap(1)
      return
    }
    setSnap(0)
    let done = false
    let touched = false
    const sec = sectionRef.current
    const onDown = () => (touched = true)
    sec?.addEventListener('pointerdown', onDown)
    const start = useApp.getState().cameraFlight
    let sawFlight = start.flying
    const raise = () => {
      if (done) return
      done = true
      if (!touched) setSnap(1)
    }
    const unsub = useApp.subscribe((st) => {
      if (st.cameraFlight.flying) sawFlight = true
      else if (sawFlight) raise()
    })
    // The globe reports flights: if none starts, the camera is already there. Without any report at
    // all (no flight status from the globe), fall back to the 2.8 s cap.
    const known = start.id !== 0 || start.arrivedAt !== 0
    const quiet = window.setTimeout(() => !sawFlight && known && raise(), 400)
    const cap = window.setTimeout(raise, 2800)
    return () => {
      done = true
      unsub()
      window.clearTimeout(quiet)
      window.clearTimeout(cap)
      sec?.removeEventListener('pointerdown', onDown)
    }
  }, [selectedId, mobile, reduced])

  const onSnapChange = useCallback(
    (i: number) => {
      setSnap(i)
      if (viewKey === 'overview') overviewSnap.current = i
    },
    [viewKey],
  )

  // Inline search on phones: the sheet rises while typing.
  useEffect(() => {
    if (mobile && searching) setSnap(2)
  }, [mobile, searching])
  useEffect(() => {
    if (computing) setSearching(false)
  }, [computing])

  // ── desktop dock height: content while computing, full at results (CSS transition) ──────
  useLayoutEffect(() => {
    const sec = sectionRef.current
    const body = bodyRef.current
    const inner = innerRef.current
    if (mobile || !sec || !body || !inner || typeof ResizeObserver === 'undefined') return
    if (!computing) {
      if (continued && lastComputingH) {
        // Remounted at the handoff: start from the readout's height and grow.
        sec.style.height = `${lastComputingH}px`
        const id = requestAnimationFrame(() => requestAnimationFrame(() => (sec.style.height = '')))
        return () => cancelAnimationFrame(id)
      }
      return
    }
    if (shownKey !== 'computing') {
      // A new place from the header search: the old overview is still leaving. Shrink toward the
      // readout's last height now (it is the same readout), never toward the outgoing overview's.
      if (lastComputingH) sec.style.setProperty('--computing-h', `${lastComputingH}px`)
      return
    }
    const measure = () => {
      const chrome = sec.offsetHeight - body.offsetHeight
      const h = Math.round(chrome + 20 + inner.offsetHeight + 22)
      // A 1-2 px difference must not restart the height transition already gliding there.
      const cur = parseFloat(sec.style.getPropertyValue('--computing-h'))
      if (!(Math.abs(cur - h) < 3)) sec.style.setProperty('--computing-h', `${h}px`)
      lastComputingH = h
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [computing, mobile, continued, shownKey])

  // Desktop pass frame: measure what sits above and below it so the square always fits (R8).
  useLayoutEffect(() => {
    const sec = sectionRef.current
    const body = bodyRef.current
    const inner = innerRef.current
    if (mobile || !sec || !body || !inner || !shownPass) return
    const measure = () => {
      const frame = inner.querySelector<HTMLElement>('[data-detail-frame]')
      if (!frame) return
      const sr = sec.getBoundingClientRect()
      const foot = body.nextElementSibling as HTMLElement | null
      // The caption's first line (the product: "SENTINEL-2 L2A · 10 M · 10.0 KM") belongs with the
      // picture: it must clear the footer too, not end half-cut under the body's fade.
      const product = frame.closest('figure')?.querySelector('figcaption')?.firstElementChild as HTMLElement | null | undefined
      const caption = product ? product.offsetHeight + 8 : 0
      const above = sr.top + body.offsetTop + 20 + (frame.getBoundingClientRect().top - inner.getBoundingClientRect().top)
      const below = (foot?.offsetHeight ?? 0) + Math.max(0, window.innerHeight - sr.bottom) + 14 + caption
      sec.style.setProperty('--detail-chrome', `${Math.round(above + below)}px`)
    }
    // The observer's first callback (after layout) does the first measure: no forced layout in the
    // commit that opens the pass.
    if (typeof ResizeObserver === 'undefined') measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(sec)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [mobile, shownPass, shownKey])

  // A long body ends on a 24 px fade, never on a clipped baseline (desktop: the body's own box).
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || mobile) return
    const update = () => {
      const more = body.scrollHeight - body.scrollTop - body.clientHeight > 2
      if (body.dataset.more !== String(more)) body.dataset.more = String(more)
    }
    if (typeof ResizeObserver === 'undefined') update()
    body.addEventListener('scroll', update, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    ro?.observe(body)
    if (innerRef.current) ro?.observe(innerRef.current)
    return () => {
      body.removeEventListener('scroll', update)
      ro?.disconnect()
    }
  }, [mobile, shownKey, full])

  useInsets(sectionRef, timelineRef, mobile, [shownKey, computing, full, shortLandscape])
  useShellExit(sectionRef, timelineRef, mobile)

  // ── render ─────────────────────────────────────────────────────────────────────────────
  // Inline search lives in the overview header: from a pass, go back to the overview first.
  const openSearch = onSearch
    ? () => {
        if (useApp.getState().selectedPassId) clearPass()
        setSearching(true)
      }
    : undefined
  const enterKey = `enter:${reportKey}`
  const dockEnter = useOnce(`${enterKey}:dock`)

  const header = shownPass && shownModel ? (
    <DetailHeader
      model={shownModel}
      pass={shownPass}
      mobile={mobile}
      onSelect={select}
      strip={mobile && !!selected && selected.id === shownPass.id}
    />
  ) : (
    <OverviewHeader
      place={place}
      model={model}
      computing={computing}
      t0={t0}
      mobile={mobile}
      enter={handoff}
      searching={searching}
      onBack={back}
      onCancel={back}
      onOpenSearch={openSearch}
      onCloseSearch={() => setSearching(false)}
      onSearch={onSearch}
      onRetry={onRetry}
    />
  )

  const footer = shownPass && shownModel ? <DetailFooter model={shownModel} pass={shownPass} mobile={mobile} shared={!!shared} onShare={setSharing} onFindYours={openSearch} onReplay={() => {
    if (mobile) setSnap(0)
    focusPass(shownPass)
  }} /> : undefined

  const swapClass = staged.stage === 'out' ? s.swapOut : staged.stage === 'in' && !handoff ? s.swapIn : undefined
  const headSwapClass = staged.stage === 'out' && headerChanging ? s.swapOut : headerEntering ? s.swapIn : undefined
  const dirStyle = { '--dir': dir } as CSSProperties

  return (
    <>
      <Sheet
        label={place ? `Satellites over ${place.label}` : 'Computing passes'}
        header={
          <GlideHeight enabled={mobile}>
            <div key={headerKeyOf(staged.shown)} className={headSwapClass} style={dirStyle}>
              {header}
            </div>
          </GlideHeight>
        }
        footer={footer}
        snaps={snaps}
        snap={snap}
        onSnapChange={onSnapChange}
        onVisibleChange={mobile ? publishSheetInset : undefined}
        className={cx(
          s.vars,
          s.panel,
          !mobile && s.desk,
          !mobile && (computing ? s.isComputing : s.isResults),
          shortLandscape && s.shortLandscape,
          continued && s.noEnter,
        )}
        bodyClassName={s.body}
        bodyRef={bodyRef}
      >
        <div ref={innerRef} key={shownKey} className={cx(s.stage, swapClass)} style={dirStyle} data-detail-root={shownPass ? '' : undefined}>
          {shownKey === 'computing' || !lastModel.current ? (
            <ComputingBody t0={t0} tz={placeTz} />
          ) : shownPass ? (
            <PassDetail key={shownPass.id} model={lastModel.current} pass={shownPass} />
          ) : (
            <Overview
              model={lastModel.current}
              mobile={mobile}
              compactTimeline={mobile || shortLandscape}
              full={full}
              enterKey={enterKey}
              selectedId={selectedId}
              onSelect={select}
              onShare={setSharing}
              onRetry={onRetry}
              invite={!!shared && !inviteClosed && !searching}
              onFindYours={openSearch}
              onCloseInvite={() => setInviteClosed(true)}
            />
          )}
        </div>
      </Sheet>

      {!mobile && !shortLandscape && model && full ? (
        <TimelineDock dockRef={timelineRef} className={cx(s.vars, s.timelineDock, dockEnter && s.dockEnter)}>
          <Timeline model={model} selectedId={selectedId} onSelect={select} />
        </TimelineDock>
      ) : null}

      {sharing && model ? <ShareFor pass={sharing} model={model} onClose={closeShare} /> : null}
    </>
  )
}

/**
 * The desktop timeline strip. When it leaves while the panel stays (a second place searched from the
 * header: the panel turns back into the computing readout), it clips away to the right instead of
 * vanishing in one frame. When the whole shell leaves, useShellExit takes both out together.
 */
function TimelineDock({ dockRef, className, children }: { dockRef: React.RefObject<HTMLDivElement | null>; className?: string; children: React.ReactNode }) {
  useLayoutEffect(() => {
    const node = dockRef.current
    // An unmount's layout cleanup runs while the node is still in the document, so it can be cloned.
    return () => {
      if (useApp.getState().phase === 'computing') exitTimeline(node)
    }
  }, [dockRef])
  return (
    <div ref={dockRef} className={className}>
      {children}
    </div>
  )
}

/** Phones: the sheet header glides to its new height when its content changes (R14). */
function GlideHeight({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useAnimatedHeight(outer, inner, enabled)
  return (
    <div ref={outer} data-anim-outer>
      <div ref={inner} data-anim-inner>
        {children}
      </div>
    </div>
  )
}

// ── overview body ─────────────────────────────────────────────────────────────────────────

interface OverviewProps {
  model: ResultsModel
  mobile: boolean
  compactTimeline: boolean
  full: boolean
  enterKey: string
  selectedId?: string
  onSelect: (p: Pass) => void
  onShare: (p: Pass) => void
  onRetry?: () => void
  invite: boolean
  onFindYours?: () => void
  onCloseInvite: () => void
}

function Overview({ model, mobile, compactTimeline, full, enterKey, selectedId, onSelect, onShare, onRetry, invite, onFindYours, onCloseInvite }: OverviewProps) {
  const { report } = model
  // Notch indices in reading order (V22): phones have no SUMMARY rule (the summary is the sheet's
  // header and hero), so their first rule is 01 / PASSES.
  const idx = (n: number) => String(mobile ? n - 1 : n).padStart(2, '0')
  const enter = useOnce(`${enterKey}:body`)
  const best = model.best
  const hero = best ? (
    <div data-peek-end className={cx(enter && s.enter)} style={enterStyle(1)}>
      <BestLook model={model} best={best} onOpen={onSelect} onShare={onShare} />
    </div>
  ) : null
  const inviteBar = invite ? (
    <div className={s.invite}>
      <p className={s.inviteText}>Something watched you this week too.</p>
      {onFindYours ? (
        <Button variant="primary" size="sm" onClick={onFindYours}>
          Find yours
        </Button>
      ) : null}
      <button type="button" className={s.inviteClose} onClick={onCloseInvite} aria-label="Dismiss">
        <Glyph name="close" size={12} />
      </button>
    </div>
  ) : null

  return (
    <>
      {inviteBar}
      {mobile ? (
        <section className={s.section} aria-label="Summary">
          {hero}
          <div data-peek-end={best ? undefined : ''}>
            <Verdicts model={model} enter={enter} />
          </div>
          {full ? (
            <div className={s.mTimeline}>
              <Timeline model={model} selectedId={selectedId} onSelect={onSelect} compact />
            </div>
          ) : (
            <div className={s.mTimeline} />
          )}
          <Notes model={model} enter={enter} />
        </section>
      ) : (
        <section className={s.section} aria-label="Summary">
          <Rule index="01" className={s.rule}>
            Summary
          </Rule>
          <div className={s.headBlock}>
            <Headline model={model} enter={enter} />
            <MoreLine model={model} enter={enter} onRetry={onRetry} />
          </div>
          {hero}
          <Verdicts model={model} enter={enter} />
          {compactTimeline && full ? (
            <div className={s.mTimeline}>
              <Timeline model={model} selectedId={selectedId} onSelect={onSelect} compact />
            </div>
          ) : null}
          <Notes model={model} enter={enter} />
        </section>
      )}
      {full ? (
        <>
          <section className={s.section} aria-label="Passes">
            <Rule index={idx(2)} className={s.rule}>
              Passes
            </Rule>
            <PassList model={model} selectedId={selectedId} onSelect={onSelect} />
          </section>
          <section className={s.section} aria-label="Watched continuously">
            <Rule index={idx(3)} className={s.rule}>
              Watched continuously
            </Rule>
            <GeoWatchers watchers={report.geo} place={report.place} days={model.windowDays} />
          </section>
          <section className={s.section}>
            <p className={s.footnote}>
              Pass times are when each satellite was closest to {report.place.label}, computed from public orbital elements
              {report.catalogFetchedAt ? ` (fetched ${report.catalogFetchedAt.slice(0, 16).replace('T', ' ')}Z)` : ''}. Local times are {model.tzLabel}.
            </p>
          </section>
        </>
      ) : null}
    </>
  )
}

// ── pass footer ───────────────────────────────────────────────────────────────────────────

function DetailFooter({
  model,
  pass,
  mobile,
  shared,
  onShare,
  onReplay,
  onFindYours,
}: {
  model: ResultsModel
  pass: Pass
  mobile: boolean
  shared: boolean
  onShare: (p: Pass) => void
  onReplay: () => void
  onFindYours?: () => void
}) {
  const capture = captureFor(model.report, pass)
  const best = model.best
  // A clouded picture: the primary action is the clearest one, not sharing a white square.
  const clearer = !!capture && isClouded(capture) && best?.kind === 'detailed' && best.pass.id !== pass.id ? best.pass : undefined
  // With the clearer-look CTA, the secondary actions become icons so the primary's words fit.
  const iconOnly = !!clearer
  const third =
    shared && onFindYours ? (
      <Button onClick={onFindYours}>Find yours</Button>
    ) : (
      <Button onClick={onReplay} title="Replay the pass on the globe" aria-label="Replay the pass" className={cx(iconOnly && s.iconBtn)}>
        <Glyph name="play" size={12} />
        {iconOnly ? null : 'Replay'}
      </Button>
    )
  return (
    <div className={cx(s.actions, clearer && s.actionsThree)}>
      {mobile ? (
        <Button onClick={clearPass} aria-label="All passes" className={s.iconBtn}>
          <Glyph name="arrow-left" size={13} />
        </Button>
      ) : null}
      {clearer ? (
        <>
          <Button variant="primary" onClick={() => focusPass(clearer)} className={s.primary} aria-label="See the clearest look">
            <span className={s.ctaLead}>See the </span>clearest look
          </Button>
          <Button onClick={() => onShare(pass)} aria-label="Share this pass" title="Share this pass" className={cx(iconOnly && s.iconBtn)}>
            <Glyph name="share" size={13} />
            {iconOnly ? null : 'Share'}
          </Button>
        </>
      ) : (
        <Button variant="primary" onClick={() => onShare(pass)} className={s.primary}>
          <Glyph name="share" size={14} />
          Share this pass
        </Button>
      )}
      {third}
    </div>
  )
}

/** The share sheet, told when the picture is mostly cloud (share SH2 renders the clouded card). */
function ShareFor({ pass, model, onClose }: { pass: Pass; model: ResultsModel; onClose: () => void }) {
  const c = captureFor(model.report, pass)
  return <ShareSheet pass={pass} report={model.report} onClose={onClose} clouded={!!c && isClouded(c)} cloudPct={c?.cloudCoverPct} />
}

// ── behaviour ─────────────────────────────────────────────────────────────────────────────

/**
 * A selection made outside this view (the controller's `?p=` deep link or `/s/<id>` share preselect,
 * or any bare `selectPass(id)`) gets the same treatment as a click: frame the pass, replay its sweep,
 * start decoding its image. Once per selected id, so a report swap (partial → final) never restarts
 * a replay the user has since paused or scrubbed.
 */
function useExternalFocus(selectedId: string | undefined, model: ResultsModel | undefined) {
  const handled = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!selectedId) {
      handled.current = undefined
      return
    }
    if (!model || handled.current === selectedId) return
    const pass = model.passById.get(selectedId)
    if (!pass) return
    handled.current = selectedId
    const cam = useApp.getState().camera
    if (cam.kind !== 'pass' || cam.passId !== selectedId) focusPass(pass)
  }, [selectedId, model])
}

/**
 * Whoever clears the selection (our back button, the app shell's Esc, a new report), the scene goes
 * back to the overview: live time, camera on the place.
 */
function useDeselectCleanup() {
  useEffect(
    () =>
      useApp.subscribe((st, prev) => {
        if (!prev.selectedPassId || st.selectedPassId) return
        if (st.timeMode !== 'live') {
          st.setTimeMode('live')
          st.setSimTime(Date.now())
        }
        if (st.camera.kind === 'pass' && st.place) st.setCamera({ kind: 'place', lat: st.place.lat, lon: st.place.lon })
      }),
    [],
  )
}

/** Stop the replay at the end of the pass window and hold that frame. */
function useReplayGuard(pass: Pass | undefined, onEnd?: () => void) {
  const endRef = useRef(onEnd)
  endRef.current = onEnd
  useEffect(() => {
    if (!pass) return
    const [, end] = replayWindow(pass)
    return useApp.subscribe((st) => {
      if (st.timeMode === 'replay' && st.simTime >= end) {
        st.setTimeMode('scrub')
        st.setSimTime(end)
        endRef.current?.()
      }
    })
  }, [pass])
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"]')
}

function useKeys(model: ResultsModel | undefined, selected: Pass | undefined, select: (p: Pass) => void, suspended: boolean) {
  const ref = useRef({ model, selected, select, suspended })
  ref.current = { model, selected, select, suspended }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { model: m, selected: sel, select: pick, suspended: off } = ref.current
      if (!m || off || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (isTyping(e.target)) return
        const next = stepPass(m.lanes, sel, e.key === 'ArrowRight' ? 1 : -1)
        if (next && next.id !== sel?.id) {
          e.preventDefault()
          pick(next)
        }
      } else if (e.key === ' ' || e.code === 'Space') {
        if (!sel || isTyping(e.target)) return
        // Let focused controls (other than pass rows) keep their native Space.
        const el = e.target as HTMLElement | null
        const control = el?.closest?.('button, a, [role="radio"], [role="button"]')
        if (control && !control.hasAttribute('data-pass-row')) return
        e.preventDefault()
        const st = useApp.getState()
        if (st.timeMode === 'live') startReplay(sel, st.replayRate)
        else togglePlay(sel)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
