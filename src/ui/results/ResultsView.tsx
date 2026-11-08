/**
 * <ResultsView/> (phase 'results'): the report.
 *
 *   desktop  right-docked panel (Sheet, 432px) above a full-width timeline strip inside the bezel
 *   mobile   bottom sheet with snap points; the headline and a compact timeline ride in its header
 *
 * Panel: 01 / SUMMARY · 03 / PASSES · 04 / WATCHED CONTINUOUSLY (02 / TIMELINE is the strip), or, with
 * a pass selected, its detail (03.1 capture, 03.2 geometry, 03.3 replay) with Share / Replay in the footer.
 *
 * Keys: ←/→ step through passes (same verdict as the selection), Space plays/pauses the replay.
 * Esc is NOT handled here: the app shell owns it (deselect, then back to search), so it never fires twice.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useApp } from '@/state/store'
import type { Pass, Place } from '@/types'
import { ShareSheet } from '@/ui/share'
import { Button, Glyph, Kbd, Rule, ScrambleOnce, Sheet, cx, fmtLat, fmtLon, useIsMobile } from '@/ui/system'
import { clearPass, focusPass, startReplay, togglePlay } from './actions'
import { GeoWatchers } from './GeoWatchers'
import { glyphForPass, markColorVar } from './lib/meta'
import { replayWindow } from './lib/replay'
import { stepPass } from './lib/timeline'
import { fmtLocalDay, fmtLocalStamp } from './lib/time'
import { useReportNow, useResultsModel, type ResultsModel } from './model'
import { PassDetail } from './PassDetail'
import { PassList } from './PassList'
import { Headline, Summary } from './Summary'
import { Timeline } from './Timeline'
import s from './results.module.css'

/** Mobile sheet snaps: header only · half · nearly full. */
const SNAPS = [0.3, 0.7, 0.92]

export interface ResultsViewProps {
  /** Back to search. Defaults to store.reset(); the app passes its controller's reset (aborts work, clears the URL). */
  onBack?: () => void
  /** Re-run the same place (e.g. after an archive outage) */
  onRetry?: () => void
  /** Search another place inline from the results header */
  onSearch?: (place: Place) => void
}

export function ResultsView({ onBack }: ResultsViewProps) {
  const report = useApp((st) => st.report)
  const selectedId = useApp((st) => st.selectedPassId)
  const model = useResultsModel(report)
  const mobile = useIsMobile()
  const now = useReportNow(report)
  const [sharing, setSharing] = useState<Pass | null>(null)
  // Phones open on the header snap: globe + headline + timeline. Selecting a pass raises it.
  const [snap, setSnap] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const listScroll = useRef(0)
  const selected = selectedId && model ? model.passById.get(selectedId) : undefined
  const back = onBack ?? (() => useApp.getState().reset())

  const select = useCallback((p: Pass) => {
    if (!useApp.getState().selectedPassId) listScroll.current = bodyRef.current?.scrollTop ?? 0
    focusPass(p)
  }, [])

  // Scroll: detail opens at the top; the list comes back where it was.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    body.scrollTop = selectedId ? 0 : listScroll.current
  }, [selectedId])

  // On phones, any selection (ours, a deep link, a shared pass) opens the sheet far enough to show
  // the picture.
  useEffect(() => {
    if (mobile && selectedId) setSnap((i) => Math.max(i, 1))
  }, [mobile, selectedId])

  useExternalFocus(selectedId, model)
  useReplayGuard(selected)
  useDeselectCleanup()
  useKeys(model, selected, select, !!sharing)
  const closeShare = useCallback(() => setSharing(null), [])

  // A selection that vanished (report replaced by the final one) falls back to the overview.
  useEffect(() => {
    if (selectedId && model && !model.passById.has(selectedId)) clearPass()
  }, [selectedId, model])

  if (!model) return null
  const { report: r, tz } = model
  const place = r.place

  const header = selected ? (
    <DetailHeader model={model} pass={selected} mobile={mobile} />
  ) : (
    <OverviewHeader model={model} mobile={mobile} onBack={back} onSelect={select} selectedId={selectedId} />
  )

  const footer = selected ? (
    <div className={s.actions}>
      <Button variant="primary" onClick={() => setSharing(selected)}>
        <Glyph name="share" size={14} />
        Share this pass
      </Button>
      <Button onClick={() => focusPass(selected)} title="Replay the pass on the globe">
        <Glyph name="play" size={12} />
        Replay
      </Button>
    </div>
  ) : undefined

  return (
    <>
      <Sheet
        label={`Satellites over ${place.label}`}
        header={header}
        footer={footer}
        snaps={SNAPS}
        snap={snap}
        onSnapChange={setSnap}
        className={cx(s.vars, s.panel)}
        bodyRef={bodyRef}
      >
        {selected ? (
          <PassDetail key={selected.id} model={model} pass={selected} />
        ) : (
          <>
            <section className={s.section} aria-label="Summary">
              <Rule index="01" className={s.rule}>
                Summary
              </Rule>
              <Summary model={model} showHeadline={!mobile} />
            </section>
            <section className={s.section} aria-label="Passes">
              <Rule index="03" className={s.rule}>
                Passes · newest first
              </Rule>
              <PassList model={model} selectedId={selectedId} now={now} onSelect={select} />
            </section>
            <section className={s.section} aria-label="Watched continuously">
              <Rule index="04" className={s.rule}>
                Watched continuously
              </Rule>
              <GeoWatchers watchers={r.geo} place={place} days={model.windowDays} />
            </section>
            <section className={s.section}>
              <p className={s.footnote}>
                Pass times are when each satellite was closest to {place.label}, computed from public orbital elements
                {r.catalogFetchedAt ? ` (fetched ${r.catalogFetchedAt.slice(0, 16).replace('T', ' ')}Z)` : ''}. Local times are {tz.replace(/_/g, ' ')}.
              </p>
            </section>
          </>
        )}
      </Sheet>

      {!mobile ? (
        <div className={cx(s.vars, s.timelineDock)}>
          <Timeline model={model} selectedId={selectedId} onSelect={select} />
        </div>
      ) : null}

      {sharing ? <ShareSheet pass={sharing} report={r} onClose={closeShare} /> : null}
    </>
  )
}

// ── headers ───────────────────────────────────────────────────────────────────────────────

function OverviewHeader({
  model,
  mobile,
  onBack,
  onSelect,
  selectedId,
}: {
  model: ResultsModel
  mobile: boolean
  onBack: () => void
  onSelect: (p: Pass) => void
  selectedId?: string
}) {
  const { report, tz } = model
  const place = report.place
  return (
    <div>
      <div className={s.headTop}>
        <span className={s.headId}>
          {Math.round(model.windowDays)} days · {shortDay(report.windowStart, tz)} → {shortDay(report.windowEnd, tz)}
        </span>
        <button type="button" className={s.crumb} onClick={onBack} aria-keyshortcuts="Escape">
          <Glyph name="search" size={11} />
          New search
          {!mobile ? <Kbd>Esc</Kbd> : null}
        </button>
      </div>
      {mobile ? (
        <>
          <Headline model={model} compact />
          <div className={s.mTimeline}>
            <Timeline model={model} selectedId={selectedId} onSelect={onSelect} compact />
          </div>
        </>
      ) : (
        <>
          <h1 className={s.placeName}>{place.label}</h1>
          <div className={s.placeSub}>
            <ScrambleOnce text={`${fmtLat(place.lat)} ${fmtLon(place.lon)}`} className={s.coordsText} />
            {place.sublabel ? <b>{place.sublabel}</b> : null}
            <span>{tz.replace(/_/g, ' ')}</span>
          </div>
        </>
      )}
    </div>
  )
}

/** "27 Oct" */
const shortDay = (ms: number, tz: string) => fmtLocalDay(ms, tz).split(' ').slice(1).join(' ')

/** Pass header. On phones it stays short (no timeline) so the whole picture fits at the middle snap. */
function DetailHeader({ model, pass, mobile }: { model: ResultsModel; pass: Pass; mobile: boolean }) {
  const meta = model.meta(pass.norad)
  return (
    <div>
      <div className={s.headTop}>
        <button type="button" className={s.crumb} onClick={clearPass} aria-keyshortcuts="Escape">
          <Glyph name="arrow-left" size={11} />
          All passes
          {!mobile ? <Kbd>Esc</Kbd> : null}
        </button>
        <span className={s.headId}>
          <ScrambleOnce text={`Pass ${pass.id}`} />
        </span>
      </div>
      <div className={s.passTitle}>
        <Glyph name={glyphForPass(pass.verdict, meta.category)} size={18} color={markColorVar(pass.verdict, meta.category)} />
        <h1 className={s.placeName}>{meta.name}</h1>
      </div>
      <div className={s.placeSub}>
        <b>{fmtLocalStamp(pass.tClosest, model.tz, true)}</b>
        {meta.operator ? <span>{meta.operator}</span> : null}
      </div>
    </div>
  )
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
function useReplayGuard(pass: Pass | undefined) {
  useEffect(() => {
    if (!pass) return
    const [, end] = replayWindow(pass)
    return useApp.subscribe((st) => {
      if (st.timeMode === 'replay' && st.simTime >= end) {
        st.setTimeMode('scrub')
        st.setSimTime(end)
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
