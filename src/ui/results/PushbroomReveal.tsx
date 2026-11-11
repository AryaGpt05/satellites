/**
 * The signature moment (DESIGN §5): a captured image is revealed line by line in the satellite's
 * along-track direction, the way a pushbroom sensor actually builds it. A 1px signal scan line with a
 * bone core leads, with a 6px trailing glow; the part not yet scanned is raster (bone hairlines
 * parallel to the front, 4px pitch) on ink, like lines waiting to be read. One in-frame counter reads
 * LINE 0000 → 1024. ≈ 1.6 s, linear (a pushbroom scans at a constant rate). Reduced motion: a fade.
 *
 * `headingDeg` is the ground-track heading at closest approach as drawn on the image, clockwise from its up (a
 * Sentinel-2 / Landsat photo is grid-north-up: the caller turns the compass heading by the meridian convergence,
 * lib/photos.ts photoHeadingDeg), so a descending Sentinel-2 pass (≈ 195°) scans from the top edge down, slightly leaning.
 *
 * When the scan starts (`startAt`):
 *   'now'      as soon as the image is decoded (a shared picture)
 *   'arrival'  the pass detail: once the camera has arrived (store.cameraFlight) + 400 ms, so the
 *              scan line crosses the centre as the swath crosses the reticle; never later than 2.8 s
 *              after mount for the camera; on phones also only once the frame is ≥ 95 % visible
 *   'hero'     the summary best look: max(decoded, mount + 480 ms, camera eta − 200 ms)
 *   'capture'  the pass view (owner C4): the globe's capture moment, i.e. replay sim time crossing the pass's
 *              closest approach `tc`, the frame the globe's scan line crosses the place. Until then the frame
 *              waits as raster with a countdown ("AWAITING PASS · T−00:00:41", read after the globe's frame, the HUD's
 *              value; neutral "AWAITING PASS" while the replay clock is not on this pass, R3-3). A quiet selection (no replay
 *              within 400 ms), a paused replay or 14 s without a crossing reveal it at once.
 * `instant` draws the finished picture at once (already revealed this session).
 *
 * Compositor-only (U-1): no canvas. The decoded photo is the view's own session <img> (R3-1, the element the
 * view keeps showing afterwards), and the part not yet scanned is a sweep layer over it (ink raster, the glow
 * and the scan line) moved by ONE transform animation along the heading. Nothing is painted on the main
 * thread per frame (a canvas cost 45–280 ms to allocate on a phone and ~25 ms per high-quality frame), so the
 * scan stays smooth while the globe works. The per-frame work is one textContent write (the LINE counter).
 * React renders at mount, at scan start, at the centre lock and at the end. The box size comes from a
 * ResizeObserver, never from layout reads in a commit.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { DUR } from '@/lib/ease'
import { useApp } from '@/state/store'
import { Button, LiveDot, cx, useReducedMotion } from '@/ui/system'
import { sceneClock } from '@/state/sceneClock'
import { awaitCountdown, useCaptureMoment } from './capture'
import { lineLabel, motionVector, REVEAL_MS, sweepRange } from './lib/pushbroom'
import { Img } from './Img'
import { loadPhoto, type PhotoView } from './images'
import { markSeen } from './once'
import s from './PushbroomReveal.module.css'

export type RevealPhase = 'loading' | 'waiting' | 'revealing' | 'done' | 'error'

interface Props {
  src: string
  /** The view whose session <img> shows the photo (R3-1): the same element stays after the reveal */
  view: PhotoView
  headingDeg: number
  /** Image lines (px height of the render) for the counter */
  lines: number
  alt: string
  /** Overlay drawn above the image (reticle, labels); receives whether the scan has passed the centre */
  overlay?: (state: { centreLocked: boolean; phase: RevealPhase }) => ReactNode
  /** Product line under the image ("Sentinel-2 L2A · 10 m · 10.0 km"); hidden when omitted */
  caption?: ReactNode
  /** Slow-network copy under ACQUIRING… */
  acquiringNote?: string
  startAt?: 'now' | 'arrival' | 'hero' | 'capture'
  /** Closest approach (sim ms) for startAt 'capture' */
  tc?: number
  /** What the frame waits for before it develops: 'pass' (default), or 'scan' for a geostationary image */
  awaiting?: 'pass' | 'scan'
  /** Marked as seen (useOnce key) when the reveal starts, so a remount shows the picture at once */
  seenKey?: string
  /** Draw the finished picture at once (no scan) */
  instant?: boolean
  /** Phones: hold the scan until the frame is (≥ 95 %) on screen */
  gateOnVisible?: boolean
  /** Dim the picture (a scene that is mostly cloud must never be the brightest thing on screen): 'cloud' ≥ 70 %, 'overcast' ≥ 90 % */
  dim?: false | 'cloud' | 'overcast'
  /** Fade the picture in (200 ms) instead of cutting to it, e.g. a close-up swapped over the full crop */
  fade?: boolean
  className?: string
  frameClassName?: string
  onPhase?: (p: RevealPhase) => void
}

/**
 * Phones: share of the frame that must be on screen before the scan starts; on a phone too short to
 * show it all, half of it once the camera has been ready this long (below half, the user has moved
 * the sheet away: the scan waits for them to bring it back).
 */
const VISIBLE_TO_SCAN = 0.95
const VISIBLE_PARTIAL = 0.5
const PARTIAL_AFTER_MS = 1200
const CAMERA_CAP_MS = 2800
const ARRIVAL_LEAD_MS = 400
const HERO_MIN_MS = 480
/** 'capture': no replay this long after mount = a quiet selection (reveal now); never wait longer than CAPTURE_CAP_MS. */
const QUIET_MS = 400
const CAPTURE_CAP_MS = 14_000
/** A new flight starts within a frame or two of a selection; wait this long before assuming none will. */
const FLIGHT_GRACE_MS = 250

export function PushbroomReveal({
  src,
  view,
  headingDeg,
  lines,
  alt,
  overlay,
  caption,
  acquiringNote,
  startAt = 'arrival',
  awaiting = 'pass',
  tc,
  seenKey,
  instant = false,
  gateOnVisible = false,
  dim = false,
  fade = false,
  className,
  frameClassName,
  onPhase,
}: Props) {
  const reduced = useReducedMotion()
  const boxRef = useRef<HTMLDivElement>(null)
  const sweepRef = useRef<HTMLDivElement | null>(null)
  const animRef = useRef<Animation | null>(null)
  const lineRef = useRef<HTMLElement>(null)
  const sizeRef = useRef({ w: 0, h: 0 })
  const progressRef = useRef(0)
  /** Share of the frame on screen (1 when not gated) */
  const visibleRef = useRef(1)
  const [phase, setPhase] = useState<RevealPhase>('loading')
  const [centreLocked, setCentreLocked] = useState(false)
  const [slow, setSlow] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const onPhaseRef = useRef(onPhase)
  onPhaseRef.current = onPhase
  const hasOverlay = !!overlay
  /** 'capture': performance.now() of the crossing (0 = not yet), and of the last frame the clock was replaying */
  const capturedAt = useRef(0)
  const replaySeenAt = useRef(0)
  /** performance.now() since when the clock has not been replaying (0 while it is) */
  const quietSince = useRef(0)
  const countRef = useRef<HTMLElement>(null)
  const phaseRef = useRef<RevealPhase>('loading')
  phaseRef.current = phase
  useCaptureMoment(
    startAt === 'capture' ? tc : undefined,
    {
      onCapture: () => {
        if (!capturedAt.current) capturedAt.current = performance.now()
      },
      onFrame: (t, mode) => {
        if (mode === 'replay') replaySeenAt.current = performance.now()
        const el = countRef.current
        if (el && tc !== undefined && (phaseRef.current === 'waiting' || phaseRef.current === 'loading')) {
          // Neutral unless the replay clock is on this pass's approach (R3-3).
          const c = awaitCountdown(t, mode, tc)
          const text = c ? ` · ${c}` : ''
          if (el.textContent !== text) el.textContent = text
        }
      },
    },
    startAt === 'capture' && phase !== 'done' && phase !== 'revealing',
  )

  const setP = useCallback((p: RevealPhase) => {
    setPhase(p)
    onPhaseRef.current?.(p)
  }, [])

  /**
   * The sweep's geometry for the box: the layer is rotated to the heading (its local +x is the motion), pivots at
   * the box centre, and its front (local x = 0) travels from the first corner the scan meets (`from`) past the last
   * (`to`). `len`/`ext` size the raster so it always covers the box ahead of the front.
   */
  const geometry = useCallback(() => {
    const { w, h } = sizeRef.current
    if (!w || !h) return null
    const d = motionVector(headingDeg)
    const [a, b] = sweepRange(w, h, d)
    const c = (w / 2) * d.x + (h / 2) * d.y
    const theta = (Math.atan2(d.y, d.x) * 180) / Math.PI
    return { theta, from: a - c - 2, to: b - c + 2, len: b - a + 8, ext: Math.hypot(w, h) + 8 }
  }, [headingDeg])
  const sweepAt = (g: { theta: number; from: number; to: number }, p: number) => `rotate(${g.theta.toFixed(3)}deg) translateX(${(g.from + (g.to - g.from) * p).toFixed(2)}px)`

  /** Put the sweep where progress p says (no animation running); the first placement shows the frame. */
  const place = useCallback(
    (p: number) => {
      const el = sweepRef.current
      const box = boxRef.current
      const g = geometry()
      if (!el || !box || !g) return
      el.style.setProperty('--sweep-len', `${g.len.toFixed(1)}px`)
      el.style.setProperty('--sweep-ext', `${g.ext.toFixed(1)}px`)
      const a = animRef.current
      if (a && a.playState !== 'finished' && a.playState !== 'idle') {
        // Resized mid-scan: the same animation, re-aimed for the new box, at the same time.
        ;(a.effect as KeyframeEffect | null)?.setKeyframes([{ transform: sweepAt(g, 0) }, { transform: sweepAt(g, 1) }])
      } else el.style.transform = sweepAt(g, p)
      if (!box.hasAttribute('data-ready')) box.setAttribute('data-ready', '')
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geometry],
  )
  const sweepRefCb = useCallback(
    (el: HTMLDivElement | null) => {
      sweepRef.current = el
      if (el) place(progressRef.current)
      else boxRef.current?.removeAttribute('data-ready')
    },
    [place],
  )

  // Size from a ResizeObserver only: its first callback arrives after layout, so mounting never forces
  // a synchronous layout of the panel inside React's commit (that read alone cost 110 ms at 4× CPU on
  // the results handoff). The sweep waits for a size; the observer re-places it at the current progress.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    if (typeof ResizeObserver === 'undefined') {
      sizeRef.current = { w: box.clientWidth, h: box.clientHeight }
      return
    }
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect
      const { w, h } = sizeRef.current
      if (Math.abs(w - r.width) < 0.5 && Math.abs(h - r.height) < 0.5) return
      sizeRef.current = { w: r.width, h: r.height }
      // A few style writes on the sweep layer only (no paint on the main thread).
      place(progressRef.current)
    })
    ro.observe(box)
    return () => ro.disconnect()
  }, [place])

  // Phones: the frame must be on screen before the scan runs: essentially all of it, so the sheet has
  // finished rising past the footer (the body clips it) and no line is read under the fold.
  useEffect(() => {
    const box = boxRef.current
    if (!gateOnVisible || !box || typeof IntersectionObserver === 'undefined') {
      visibleRef.current = 1
      return
    }
    visibleRef.current = 0
    const io = new IntersectionObserver((e) => (visibleRef.current = e[e.length - 1].intersectionRatio), { threshold: [0, VISIBLE_PARTIAL, 0.75, VISIBLE_TO_SCAN, 1] })
    io.observe(box)
    return () => io.disconnect()
  }, [gateOnVisible])

  // Load → wait for the moment → reveal.
  useEffect(() => {
    let alive = true
    let raf = 0
    let poll = 0
    const ctl = new AbortController()
    const mountedAt = performance.now()
    animRef.current?.cancel()
    animRef.current = null
    progressRef.current = 0
    setCentreLocked(false)
    setSlow(false)
    setP('loading')
    if (lineRef.current) lineRef.current.textContent = lineLabel(0)
    const slowTimer = window.setTimeout(() => alive && setSlow(true), 4500)

    const finish = () => {
      progressRef.current = 1
      if (lineRef.current) lineRef.current.textContent = lineLabel(lines)
      setCentreLocked(true)
      setP('done')
    }
    const run = () => {
      if (!alive) return
      if (seenKey) markSeen(seenKey)
      useApp.getState().holdMotion(DUR.pushbroom + 200)
      const el = sweepRef.current
      const g = geometry()
      if (reduced || !el || !g || typeof el.animate !== 'function') {
        finish()
        return
      }
      setP('revealing')
      // The scan itself: one linear transform animation (a pushbroom reads at a constant rate), on the compositor.
      el.style.transform = sweepAt(g, 0)
      const anim = el.animate([{ transform: sweepAt(g, 0) }, { transform: sweepAt(g, 1) }], { duration: REVEAL_MS, easing: 'linear', fill: 'forwards' })
      animRef.current = anim
      anim.onfinish = () => alive && finish()
      // The counter and the centre lock follow the animation's clock (a render only when an overlay needs it).
      let locked = !hasOverlay
      const tick = () => {
        if (!alive || animRef.current !== anim) return
        const p = Math.min(1, Math.max(0, Number(anim.currentTime ?? 0) / REVEAL_MS))
        progressRef.current = p
        if (lineRef.current) lineRef.current.textContent = lineLabel(Math.round(p * lines))
        if (!locked && p >= 0.5) {
          locked = true
          setCentreLocked(true)
        }
        if (p < 1) raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }

    /** When the camera lets the scan start (performance.now() ms), or undefined while it is still flying. */
    const cameraReadyAt = (now: number): number | undefined => {
      const f = useApp.getState().cameraFlight
      if (startAt === 'capture') {
        if (capturedAt.current) return now
        if (now - mountedAt >= CAPTURE_CAP_MS) return now
        // Quiet: the clock has not been in replay for QUIET_MS (a gallery swipe, a paused replay, reduced motion).
        // Read from the clock's mode now, not from the last frame (a slow frame must not look like a pause).
        const replaying = sceneClock.mode === 'replay' || useApp.getState().timeMode === 'replay'
        if (replaying) quietSince.current = 0
        else if (!quietSince.current) quietSince.current = now
        if (!replaying && now - quietSince.current >= QUIET_MS) return now
        return undefined
      }
      if (startAt === 'hero') return Math.max(mountedAt + HERO_MIN_MS, f.flying ? f.eta - 200 : 0)
      if (now - mountedAt >= CAMERA_CAP_MS) return now
      if (f.flying) return undefined
      // A flight that arrived before this mount is the previous one: give a new one a moment to start.
      if (f.arrivedAt < mountedAt) return now - mountedAt >= FLIGHT_GRACE_MS ? now : undefined
      return f.arrivedAt + ARRIVAL_LEAD_MS
    }

    const schedule = () => {
      if (!alive) return
      const now = performance.now()
      if (startAt === 'now') return run()
      const at = cameraReadyAt(now)
      const seen = visibleRef.current
      if (at !== undefined && now >= at && (seen >= VISIBLE_TO_SCAN || (seen >= VISIBLE_PARTIAL && now >= at + PARTIAL_AFTER_MS))) return run()
      poll = window.setTimeout(schedule, at !== undefined && at > now ? Math.min(100, at - now) : 50)
    }

    // The results' shared loader: the same request (and decoded element) every other view of this photo uses.
    loadPhoto(src, ctl.signal)
      .then(() => {
        if (!alive) return
        window.clearTimeout(slowTimer)
        if (instant) return finish()
        // The photo and the sweep over it mount together; the sweep is placed in its ref callback (before paint).
        setP('waiting')
        schedule()
      })
      .catch(() => {
        if (!alive) return
        window.clearTimeout(slowTimer)
        setP('error')
      })
    return () => {
      alive = false
      ctl.abort()
      cancelAnimationFrame(raf)
      animRef.current?.cancel()
      animRef.current = null
      window.clearTimeout(poll)
      window.clearTimeout(slowTimer)
    }
    // `attempt` re-runs the load on retry. `instant`/`startAt` are read at start only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, lines, reduced, geometry, setP, attempt])

  return (
    <figure className={cx(s.figure, className)}>
      <div
        ref={boxRef}
        className={cx(s.frame, phase !== 'done' && s.loading, phase === 'error' && s.errored, frameClassName)}
        data-done={phase === 'done' ? '' : undefined}
      >
        {phase !== 'loading' && phase !== 'error' ? <Img view={view} url={src} alt={alt} className={cx(s.pic, reduced || fade ? s.fade : undefined, dim === 'cloud' && s.dimCloud, dim === 'overcast' && s.dim)} /> : null}
        {(phase === 'waiting' || phase === 'revealing') && !reduced ? (
          <div ref={sweepRefCb} className={s.sweep} aria-hidden>
            <span className={s.raster} />
            <span className={s.glow} />
            <span className={s.front} />
          </div>
        ) : null}
        {phase === 'loading' ? (
          <div className={s.state} role="status">
            <span className={s.stateMain}>
              Acquiring<span className={s.caret} aria-hidden />
            </span>
            <span className={s.stateNote}>{slow ? 'Still rendering. Large scenes can take 10 s or more.' : acquiringNote}</span>
          </div>
        ) : null}
        {phase === 'error' ? (
          <div className={s.state} role="alert">
            <span className={s.stateMain}>No image returned</span>
            <span className={s.stateNote}>The archive did not send this crop. It may be busy; the image itself still exists.</span>
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)} className={s.retry}>
              Retry
            </Button>
          </div>
        ) : null}
        {overlay ? <div className={s.overlay}>{overlay({ centreLocked, phase })}</div> : null}
        {/* The one counter: it rides on the image while it scans. */}
        <span className={cx(s.scanChip, phase === 'revealing' && s.scanChipOn)} aria-hidden data-scan-chip>
          {/* A fixed slot: the dot leaving at the end must not move the counter (U-2). */}
          <span className={s.dotSlot}>{phase === 'revealing' ? <LiveDot className={s.dot} /> : null}</span>
          Line <b ref={lineRef}>{lineLabel(0)}</b> → {lineLabel(lines)}
        </span>
        {startAt === 'capture' && tc !== undefined ? (
          <span className={cx(s.awaitChip, phase === 'waiting' && s.scanChipOn)} aria-hidden>
            Awaiting {awaiting}
            <b ref={countRef}>{awaitText(tc)}</b>
          </span>
        ) : null}
      </div>
      {caption ? <figcaption className={s.caption}>{caption}</figcaption> : null}
    </figure>
  )
}

/** The chip's first words, before the first frame writes them: the same neutral rule. */
function awaitText(tc: number): string {
  const c = awaitCountdown(sceneClock.simTime, sceneClock.mode, tc)
  return c ? ` · ${c}` : ''
}
