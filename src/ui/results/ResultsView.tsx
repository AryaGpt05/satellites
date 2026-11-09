/**
 * <ResultsView/>: the ONE results panel, from computing through results to a pass (decision #10).
 * Mounted for phase 'computing' and 'results'; it keys off the phase, not off the report.
 *
 *   desktop  right-docked panel (Sheet). While computing it is as tall as its readout; when results
 *            land it grows to the full dock above the timeline strip (beside it on short screens).
 *   phones   bottom sheet with content-measured snaps: computing = the readout; overview = header +
 *            the gallery's first card (the peek); a pass = flight (header + footer), then image.
 *
 * Contents swap in two beats (old out 160 ms, new in 240 ms), never as a page cut. Overview:
 * 01 / SUMMARY (headline, the photo gallery, readouts) · 02 / PASSES · 03 / WATCHED CONTINUOUSLY, and the
 * 04 / TIMELINE strip. A pass with a photo ('photo'): the gallery (persistent while you swipe, owner B), then
 * its readouts, 01 / GEOMETRY, 02 / REPLAY, with Share / Replay in the footer; a quiet selection from the
 * gallery changes the words in place, never the panel. A pass with no photo: its plan view.
 *
 * Keys: ←/→ walk the photos (the gallery) or, on a pass without one, step through passes of its verdict;
 * F opens the photo large (the lightbox); Space plays/pauses the replay. Esc is NOT handled here (except
 * inside the inline search field and the lightbox): the app shell owns it.
 */
import { startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { timeZoneAt } from '@/imagery'
import { SHORT_LANDSCAPE_QUERY } from '@/lib/layout'
import { useApp } from '@/state/store'
import type { Pass, Place } from '@/types'
import { ShareSheet } from '@/ui/share'
import { Button, Glyph, Rule, Sheet, cx, useIsMobile, useMediaQuery, useReducedMotion } from '@/ui/system'
import { GeoLook } from './BestLook'
import { ComputingBody } from './ComputingBody'
import { Gallery, galleryCtl } from './Gallery'
import { Lightbox } from './Lightbox'
import { GeoWatchers } from './GeoWatchers'
import { DetailHeader, OverviewHeader, rememberPlace } from './Headers'
import { PassDetail, PhotoPassView } from './PassDetail'
import { PassList } from './PassList'
import { Headline, MoreLine, Notes, Verdicts, enterStyle } from './Summary'
import { Timeline } from './Timeline'
import { clearPass, focusPass, quiet, startReplay, togglePlay } from './actions'
import { crossed, onSceneFrame } from './capture'
import { useGallery } from './gallery'
import { isClouded } from './lib/bestLook'
import { captureFor } from './lib/captures'
import { replayWindow } from './lib/replay'
import { stepPass } from './lib/timeline'
import { useResultsModel, type ResultsModel } from './model'
import { useOnce } from './once'
import { SHORT_DESK_QUERY, exitTimeline, lastShellUnmount, publishSheetInset, rememberComputingSnap, lastComputingSnapPx, useAnimatedHeight, useInsets, useSheetGeometry, useShellExit, useStagedKey } from './shell'
import s from './results.module.css'

export interface ResultsViewProps {
  /** Back to search. Defaults to store.reset(); the app passes its controller's reset (aborts work, clears the URL). */
  onBack?: () => void
  /** Re-run the same place (e.g. after an archive outage) */
  onRetry?: () => void
  /** Search another place inline from the results header */
  onSearch?: (place: Place) => void
}

/** R3-5, phones: the clock not replaying this long (paused, scrubbed) once the camera is there raises the sheet. */
const SHEET_QUIET_MS = 600
/** Sim time frozen this long with no camera flight: no globe is drawing, raise. */
const SHEET_STALL_MS = 1500
/** Never hold the sheet low longer than this (a real approach + dive takes 6–8 s). */
const SHEET_CAP_MS = 14_000
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
  const shortDesk = useMediaQuery(SHORT_DESK_QUERY) && !mobile && !shortLandscape
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
  // A pass with a photo is the 'photo' view: the gallery persists while the selection moves (owner B).
  const selectedIsPhoto = selectedValid && !!model?.photoByPass.has(selectedId!)
  const viewKey = computing ? 'computing' : selectedValid ? (selectedIsPhoto ? 'photo' : `pass:${selectedId}`) : 'overview'
  // Remember where the list was before leaving it.
  useEffect(() => {
    if (viewKey !== 'overview' && viewKey !== 'computing' && bodyRef.current && !bodyRef.current.querySelector('[data-detail-root]')) listScroll.current = bodyRef.current.scrollTop
  }, [viewKey])
  const staged = useStagedKey(viewKey)
  const shownModel = lastModel.current
  const livePhotoPass = selectedIsPhoto && model ? model.passById.get(selectedId!) : undefined
  const lastPhotoPass = useRef<Pass | undefined>(undefined)
  if (livePhotoPass) lastPhotoPass.current = livePhotoPass
  const shownPass =
    staged.shown === 'photo' ? (livePhotoPass ?? lastPhotoPass.current) : staged.shown.startsWith('pass:') ? shownModel?.passById.get(staged.shown.slice(5)) : undefined
  const isDetailKey = (k: string) => k === 'photo' || k.startsWith('pass:')
  const shownKey = shownPass ? staged.shown : staged.shown === 'computing' && !computing ? 'computing' : isDetailKey(staged.shown) ? 'overview' : staged.shown
  const headerKeyOf = (k: string) => (isDetailKey(k) ? k : 'overview')
  const headerChanging = headerKeyOf(viewKey) !== headerKeyOf(staged.shown)
  const headerEntering = staged.stage === 'in' && headerKeyOf(staged.prev) !== headerKeyOf(staged.shown)
  const prevPass = staged.prev.startsWith('pass:') ? shownModel?.passById.get(staged.prev.slice(5)) : undefined
  const dir = !shownPass ? -1 : prevPass && prevPass.tClosest > shownPass.tClosest ? -1 : 1
  const handoff = staged.prev === 'computing' && shownKey === 'overview'

  // Scroll: a pass opens at the top (while its content is still at opacity ~0, so the jump is never seen).
  // The overview's list position comes back once its sections have mounted (below).
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || shownKey === 'overview') return
    const id = requestAnimationFrame(() => {
      body.scrollTop = 0
    })
    return () => cancelAnimationFrame(id)
  }, [shownKey])

  // The results handoff: let the globe keep its GPU work for after the entrance.
  useEffect(() => {
    if (handoff) useApp.getState().holdMotion(900)
  }, [handoff])

  // Staging (PERF-03, R2R7): the list, the geostationary frames and the compact timeline mount one frame
  // after the summary, in a transition, on EVERY overview entrance (back from a pass costs one short task).
  // Keyed on the report SHOWN (R2R8): the outgoing overview keeps its sections through a New search swap-out.
  const keyOf = (r: { windowEnd: number; place: { lat: number; lon: number } }) => `${r.windowEnd}:${r.place.lat},${r.place.lon}`
  const reportKey = model ? keyOf(model.report) : ''
  const shownReportKey = lastModel.current ? keyOf(lastModel.current.report) : ''
  const entries = useRef({ key: '', n: 0 })
  if (entries.current.key !== shownKey) {
    if (shownKey === 'overview') entries.current.n++
    entries.current.key = shownKey
  }
  const fullKey = shownReportKey ? `${shownReportKey}:${entries.current.n}` : ''
  const [fullFor, setFullFor] = useState('')
  const full = !!fullKey && fullFor === fullKey
  useEffect(() => {
    if (!fullKey || fullFor === fullKey) return
    const id = requestAnimationFrame(() => startTransition(() => setFullFor(fullKey)))
    return () => cancelAnimationFrame(id)
  }, [fullKey, fullFor])
  // Back to the overview: the list comes back where the user left it, once its sections are there.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!full || shownKey !== 'overview' || !body) return
    if (Math.abs(body.scrollTop - listScroll.current) > 1) body.scrollTop = listScroll.current
  }, [full, shownKey])
  // The desktop timeline strip mounts once per report (it persists across a pass and back).
  const [dockFor, setDockFor] = useState('')
  useEffect(() => {
    if (full && reportKey && dockFor !== reportKey) setDockFor(reportKey)
  }, [full, reportKey, dockFor])
  const dockFull = !!reportKey && dockFor === reportKey

  // A new report (a new place) starts its gallery on the cover again.
  useEffect(() => {
    if (reportKey) useGallery.getState().reset(reportKey)
  }, [reportKey])

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
  const geo = useSheetGeometry(bodyRef, innerRef, mobile, shownKey, [shownKey, full])
  if (geo && geo.key === 'computing') rememberComputingSnap(Math.min(window.innerHeight * 0.8, geo.top + geo.pad + geo.content + 18))
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight
  // The snaps (and index) the sheet was last given: a view whose content is not measured yet holds the sheet there.
  const lastShown = useRef<{ snaps: number[]; index: number } | null>(null)
  let heldIndex: number | undefined
  const snaps = (() => {
    if (shownKey === 'computing') {
      // R2R8: the computing snap is measured from the readout; while the outgoing overview is still mounted,
      // use the readout's last measure, so the sheet glides down once, in one direction.
      const c = geo && geo.key === 'computing' ? Math.min(vh * 0.8, geo.top + geo.pad + geo.content + 18) : (lastComputingSnapPx() ?? vh * 0.4)
      return [c, TOP]
    }
    if (!geo) return [0.42, MID, TOP]
    // The content changed (a pass opened, back to the overview, results landed) but its geometry is the previous
    // view's for a frame: hold the sheet where it is (the same snap list, so the same sheet height, and the same
    // index), so it glides once, to the measured target, never first toward a stale one (A1: one move per element
    // per action).
    if (geo.key !== shownKey && lastShown.current) {
      heldIndex = lastShown.current.index
      return lastShown.current.snaps
    }
    const pad = geo.pad
    if (shownKey === 'overview') {
      const peek = geo.peekEnd !== undefined ? geo.top + pad + geo.peekEnd + 12 : vh * 0.36
      return [Math.min(peek, vh * (MID - 0.02)), MID, TOP]
    }
    const flight = Math.min(geo.top + geo.foot + 2, vh * 0.4)
    const imageSnap = geo.imageEnd !== undefined ? geo.top + pad + geo.imageEnd + 8 + geo.foot : vh * 0.7
    // R2R3: on a short phone the globe band above the sheet would be under ~120 px: the image step goes to
    // the top snap (the sheet meets the HUD band; the globe is simply out of view).
    const band = vh - imageSnap - useApp.getState().uiInsets.top
    const image = band < 120 ? vh * TOP - 1 : Math.max(Math.min(imageSnap, vh * (TOP - 0.02)), flight + 40)
    return [flight, image, TOP]
  })()

  const sheetSnap = heldIndex ?? snap
  lastShown.current = { snaps, index: Math.min(sheetSnap, snaps.length - 1) }

  // Phase / view changes pick the snap. A new search drops to the computing snap at once (R2R8: one glide down);
  // the overview's snap applies when the overview is the content shown, so Back never first drops the sheet to the
  // outgoing pass's lowest snap.
  useEffect(() => {
    if (mobile && viewKey === 'computing') setSnap(0)
  }, [viewKey, mobile])
  useEffect(() => {
    if (mobile && shownKey === 'overview') setSnap(overviewSnap.current)
  }, [shownKey, mobile])
  // A new place opens on the peek again.
  useEffect(() => {
    overviewSnap.current = 0
  }, [placeKey])

  // A pass on phones (R3-5): the sheet stays at its low flight snap through the approach and the dive (the globe's
  // sequence is the show), and rises at the capture moment: the replay clock carrying sim time across the pass's
  // closest approach, the frame the globe's scan line crosses the place (read after the globe's frame, as the HUD
  // readout). It also rises when the clock is not replaying (paused or scrubbed) once the camera is there, when a
  // replay resumed past the capture, when no globe is drawing, and at a cap. Reduced motion: at once. A quiet
  // selection (a gallery swipe) never moves the sheet; a finger on the sheet keeps it where the user put it.
  const [replayNonce, setReplayNonce] = useState(0)
  const passOf = useRef<(id: string) => Pass | undefined>(() => undefined)
  passOf.current = (id) => lastModel.current?.passById.get(id)
  useEffect(() => {
    if (!mobile || !selectedId) return
    if (quiet.id === selectedId) return
    if (reduced) {
      setSnap(1)
      return
    }
    setSnap(0)
    const tc = passOf.current(selectedId)?.tClosest
    let done = false
    let touched = false
    const sec = sectionRef.current
    const onDown = () => (touched = true)
    sec?.addEventListener('pointerdown', onDown)
    const raise = () => {
      if (done) return
      done = true
      if (!touched) setSnap(1)
    }
    const startedAt = performance.now()
    let prev: number | null = null
    let late = false
    let quietSince = 0
    let lastT = NaN
    let lastTAt = startedAt
    const off = onSceneFrame((t, mode) => {
      if (done) return
      const now = performance.now()
      const st = useApp.getState()
      const flying = st.cameraFlight.flying
      // Sim time held still while the camera flies (the replay waits for it) is not a stall.
      if (t !== lastT || flying) {
        lastT = t
        lastTAt = now
      }
      if (mode === 'replay' && tc !== undefined) {
        quietSince = 0
        if (crossed(prev, t, tc)) return raise()
        // The first replay frame already past the capture (a replay resumed late): rise once the camera is there.
        if (prev === null && t >= tc) late = true
        prev = t
        if (late && !flying) return raise()
      } else {
        prev = null
        // The store asks for a replay the globe has not taken up yet: not quiet.
        if (st.timeMode === 'replay') quietSince = 0
        else if (!quietSince) quietSince = now
        if (quietSince && !flying && now - quietSince >= SHEET_QUIET_MS && now - startedAt >= SHEET_QUIET_MS) return raise()
      }
      // No globe drawing (sim time frozen with nothing flying), or a sequence that never gets there.
      if ((!flying && now - lastTAt >= SHEET_STALL_MS) || now - startedAt >= SHEET_CAP_MS) raise()
    })
    return () => {
      done = true
      off()
      sec?.removeEventListener('pointerdown', onDown)
    }
  }, [selectedId, replayNonce, mobile, reduced])

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
      // The next search starts from the readout itself, without this run's slow-archive note (which appears
      // late, and only sometimes): the panel shrinks to it in one glide (A1).
      const readout = inner.querySelector<HTMLElement>('[data-readout]')
      lastComputingH = readout ? Math.round(chrome + 20 + readout.offsetTop + readout.offsetHeight + 22) : h
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [computing, mobile, continued, shownKey])

  // Desktop pass frame: measure what sits above and below it so the square always fits (R8, R2R5): above it
  // the header and the gallery's bar; below it the caption and credit, the body's 24 px end fade, the footer.
  // The square shrinks instead of pushing the credit into the fade.
  useLayoutEffect(() => {
    const sec = sectionRef.current
    const body = bodyRef.current
    const inner = innerRef.current
    if (mobile || !sec || !body || !inner || !shownPass) return
    const measure = () => {
      const frame = inner.querySelector<HTMLElement>('[data-gallery="detail"] [data-current] [data-photo-frame]') ?? inner.querySelector<HTMLElement>('[data-detail-frame]')
      if (!frame) return
      const sr = sec.getBoundingClientRect()
      const foot = body.nextElementSibling as HTMLElement | null
      const cap = frame.parentElement?.querySelector('figcaption') as HTMLElement | null
      const caption = cap ? cap.offsetHeight + 8 : 0
      const above = sr.top + body.offsetTop + 20 + (frame.getBoundingClientRect().top - inner.getBoundingClientRect().top)
      const below = (foot?.offsetHeight ?? 0) + Math.max(0, window.innerHeight - sr.bottom) + caption + 24 + 4
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

  // Scroll edges (R2R5): a long body ends on a 24 px fade, never on a clipped baseline, and once scrolled it
  // starts on a 16 px fade, so no row is ever hard-cut at the header hairline (desktop: the body's own box).
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || mobile) return
    let raf = 0
    const update = () => {
      raf = 0
      const more = body.scrollHeight - body.scrollTop - body.clientHeight > 2
      const scrolled = body.scrollTop > 0
      if (body.dataset.more !== String(more)) body.dataset.more = String(more)
      if (body.dataset.scrolled !== String(scrolled)) body.dataset.scrolled = String(scrolled)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    if (typeof ResizeObserver === 'undefined') update()
    body.addEventListener('scroll', onScroll, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null
    ro?.observe(body)
    if (innerRef.current) ro?.observe(innerRef.current)
    return () => {
      body.removeEventListener('scroll', onScroll)
      ro?.disconnect()
      cancelAnimationFrame(raf)
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
  const enterKey = `enter:${reportKey || shownReportKey}`
  const dockEnter = useOnce(`${enterKey}:dock`)
  // R2R10: a share recipient looking at the shared pass is pointed to their own place.
  const sharedPass = !!shared && !!shownPass && shared.norad === shownPass.norad && shared.tClosest !== undefined && Math.abs(shared.tClosest - shownPass.tClosest) <= 60_000

  const header = shownPass && shownModel ? (
    <DetailHeader
      model={shownModel}
      pass={shownPass}
      mobile={mobile}
      onSelect={select}
      photo={shownKey === 'photo'}
      shared={shared ? { sat: shared.satName ?? shownModel.meta(shownPass.norad).name, place: shared.placeLabel } : undefined}
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

  const replayShown = useCallback(
    (p: Pass) => {
      if (mobile) {
        setSnap(0)
        // The same pass replayed again: the sheet waits for its capture moment again (R3-5).
        setReplayNonce((n) => n + 1)
      }
      focusPass(p)
    },
    [mobile],
  )
  const footer = shownPass && shownModel ? (
    <DetailFooter
      model={shownModel}
      pass={shownPass}
      mobile={mobile}
      sharedPass={sharedPass}
      onShare={setSharing}
      onCheckPlace={openSearch}
      onReplay={() => replayShown(shownPass)}
    />
  ) : undefined

  const swapClass = staged.stage === 'out' ? s.swapOut : staged.stage === 'in' && !handoff ? s.swapIn : undefined
  const headSwapClass = staged.stage === 'out' && headerChanging ? s.swapOut : headerEntering ? s.swapIn : undefined
  const dirStyle = { '--dir': dir } as CSSProperties

  return (
    <>
      <Sheet
        label={place ? `Satellites over ${place.label}` : 'Computing passes'}
        header={
          <GlideHeight swapKey={headerKeyOf(staged.shown)}>
            <div key={headerKeyOf(staged.shown)} className={headSwapClass} style={dirStyle}>
              {header}
            </div>
          </GlideHeight>
        }
        footer={footer}
        snaps={snaps}
        snap={sheetSnap}
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
          ) : shownPass && shownKey === 'photo' ? (
            <PhotoPassView model={lastModel.current} pass={shownPass} mobile={mobile} />
          ) : shownPass ? (
            <PassDetail key={shownPass.id} model={lastModel.current} pass={shownPass} />
          ) : (
            <Overview
              model={lastModel.current}
              mobile={mobile}
              compactTimeline={mobile || shortLandscape}
              noSummaryRule={shortDesk}
              full={full}
              enterKey={enterKey}
              selectedId={selectedId}
              onSelect={select}
              onShare={setSharing}
              onRetry={onRetry}
              invite={!!shared && !inviteClosed && !searching}
              onCheckPlace={openSearch}
              onCloseInvite={() => setInviteClosed(true)}
            />
          )}
        </div>
      </Sheet>

      {!mobile && !shortLandscape && model && dockFull ? (
        <TimelineDock dockRef={timelineRef} className={cx(s.vars, s.timelineDock, dockEnter && s.dockEnter)}>
          <Timeline model={model} selectedId={selectedId} onSelect={select} index={shortDesk ? '03' : '04'} />
        </TimelineDock>
      ) : null}

      {model ? <Lightbox model={model} mobile={mobile} onReplay={replayShown} /> : null}
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

const FLOW_ROOT: CSSProperties = { display: 'flow-root' }

/**
 * The sheet header's box. R3-8: its height changes in ONE step, swaps and in-place changes alike (results arrival,
 * Back, New search): the Sheet draws the body below the header with a transform set in the same frame (R3-9), so
 * nothing is pushed in layout and no height is animated (a 240 ms height glide re-laid the header out every frame).
 * The outer/inner pair stays as the geometry's markers (useSheetGeometry reads the header at its natural height).
 */
function GlideHeight({ swapKey, children }: { swapKey: string; children: React.ReactNode }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useAnimatedHeight(outer, inner, false, swapKey)
  return (
    <div ref={outer} data-anim-outer>
      {/* flow-root: the swapped content's own margins stay inside (a header whose first row has a negative margin
          must not pull this box's top with it: that moved the whole header 6 px on every swap, R3-8). */}
      <div ref={inner} data-anim-inner style={FLOW_ROOT}>
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
  /** Short laptops: no 01 / SUMMARY notch (the passes are 01, as on phones) */
  noSummaryRule?: boolean
  full: boolean
  enterKey: string
  selectedId?: string
  onSelect: (p: Pass) => void
  onShare: (p: Pass) => void
  onRetry?: () => void
  invite: boolean
  onCheckPlace?: () => void
  onCloseInvite: () => void
}

function Overview({ model, mobile, compactTimeline, noSummaryRule = false, full, enterKey, selectedId, onSelect, onShare, onRetry, invite, onCheckPlace, onCloseInvite }: OverviewProps) {
  const { report } = model
  // Notch indices in reading order (V22): phones have no SUMMARY rule (the summary is the sheet's
  // header and hero), so their first rule is 01 / PASSES; short laptops likewise (R2R1).
  const idx = (n: number) => String(mobile || noSummaryRule ? n - 1 : n).padStart(2, '0')
  const enter = useOnce(`${enterKey}:body`)
  // The summary leads with the photos (owner B): the gallery, photo #1 being the closest look. With no photo
  // at all, the geostationary imager that sees the place all week.
  const hero = model.photos.length ? (
    <div data-peek-end className={cx(enter && s.enter)} style={enterStyle(1)}>
      <Gallery model={model} context="hero" mobile={mobile} onReplay={onSelect} onShare={onShare} />
    </div>
  ) : model.best?.kind === 'geo' ? (
    <div data-peek-end className={cx(enter && s.enter)} style={enterStyle(1)}>
      <GeoLook model={model} best={model.best} />
    </div>
  ) : null
  const inviteBar = invite ? (
    <div className={s.invite}>
      <p className={s.inviteText}>Something watched you this week too.</p>
      {onCheckPlace ? (
        <Button variant="primary" size="sm" onClick={onCheckPlace}>
          Check your place
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
          <div data-peek-end={hero ? undefined : ''}>
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
          {noSummaryRule ? null : (
            <Rule index="01" className={s.rule}>
              Summary
            </Rule>
          )}
          <div className={s.headBlock}>
            <Headline model={model} enter={enter} />
            <MoreLine model={model} enter={enter} onRetry={onRetry} />
          </div>
          {hero}
          <Verdicts model={model} enter={enter} />
          {compactTimeline ? (
            <div className={s.mTimeline}>{full ? <Timeline model={model} selectedId={selectedId} onSelect={onSelect} compact /> : null}</div>
          ) : null}
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
            {/* Laptops: the caveats close the overview, so the passes notch shows on the first screen (R2R1). */}
            {mobile ? null : <Notes model={model} />}
            <p className={s.footnote}>
              Pass times are when each satellite was closest to {report.place.label}, computed from public orbital elements
              {report.catalogFetchedAt ? ` (fetched ${report.catalogFetchedAt.slice(0, 16).replace('T', ' ')}Z)` : ''}. Local times are {model.tzLabel}.
            </p>
          </section>
        </>
      ) : (
        // Reserve the passes notch while the sections stage in, so the summary never shifts (A1).
        <section className={s.section} aria-hidden>
          <Rule index={idx(2)} className={s.rule}>
            Passes
          </Rule>
        </section>
      )}
    </>
  )
}

// ── pass footer ───────────────────────────────────────────────────────────────────────────

function DetailFooter({
  model,
  pass,
  mobile,
  sharedPass,
  onShare,
  onReplay,
  onCheckPlace,
}: {
  model: ResultsModel
  pass: Pass
  mobile: boolean
  /** A share recipient looking at the shared pass (R2R10) */
  sharedPass: boolean
  onShare: (p: Pass) => void
  onReplay: () => void
  onCheckPlace?: () => void
}) {
  const capture = captureFor(model.report, pass)
  const cover = model.cover?.photo
  // A clouded picture: the primary action is the clearest one, not sharing a white square.
  const clearer = !sharedPass && !!capture && isClouded(capture) && cover?.pass && !cover.clouded && cover.pass.id !== pass.id ? cover.pass : undefined
  // R2R10: the recipient's primary is their own place; Share and Replay become icons.
  const iconOnly = !!clearer || (sharedPass && !!onCheckPlace)
  const replay = (
    <Button onClick={onReplay} title="Replay the pass on the globe" aria-label="Replay the pass" className={cx(iconOnly && s.iconBtn)}>
      <Glyph name="play" size={12} />
      {iconOnly ? null : 'Replay'}
    </Button>
  )
  const shareIcon = (
    <Button onClick={() => onShare(pass)} aria-label="Share this pass" title="Share this pass" className={s.iconBtn}>
      <Glyph name="share" size={13} />
    </Button>
  )
  return (
    <div className={cx(s.actions, iconOnly && s.actionsThree)}>
      {mobile ? (
        <Button onClick={clearPass} aria-label="All passes" className={s.iconBtn}>
          <Glyph name="arrow-left" size={13} />
        </Button>
      ) : null}
      {sharedPass && onCheckPlace ? (
        <>
          <Button variant="primary" onClick={onCheckPlace} className={s.primary}>
            <Glyph name="search" size={13} />
            Check your place
          </Button>
          {shareIcon}
        </>
      ) : clearer ? (
        <>
          <Button variant="primary" onClick={() => focusPass(clearer)} className={s.primary} aria-label="See the clearest look">
            <span className={s.ctaLead}>See the </span>clearest look
          </Button>
          {shareIcon}
        </>
      ) : (
        <Button variant="primary" onClick={() => onShare(pass)} className={s.primary}>
          <Glyph name="share" size={14} />
          Share this pass
        </Button>
      )}
      {replay}
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
        const dir = e.key === 'ArrowRight' ? 1 : -1
        // The photos first (owner B): the gallery on screen walks them (the summary, or a pass with a photo).
        if (galleryCtl.current && (!sel || m.photoByPass.has(sel.id))) {
          e.preventDefault()
          galleryCtl.current.step(dir)
          return
        }
        const next = stepPass(m.lanes, sel, dir)
        if (next && next.id !== sel?.id) {
          e.preventDefault()
          pick(next)
        }
      } else if ((e.key === 'f' || e.key === 'F') && !isTyping(e.target)) {
        if (galleryCtl.current?.expand()) e.preventDefault()
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
