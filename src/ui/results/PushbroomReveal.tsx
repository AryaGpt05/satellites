/**
 * The signature moment (DESIGN §5): a captured image is revealed line by line in the satellite's
 * along-track direction, the way a pushbroom sensor actually builds it. A 1px signal scan line with a
 * bone core leads, with a 6px trailing glow; the part not yet scanned is raster (bone hairlines
 * parallel to the front, 4px pitch) on ink, like lines waiting to be read. One in-frame counter reads
 * LINE 0000 → 1024. ≈ 1.6 s, linear (a pushbroom scans at a constant rate). Reduced motion: a fade.
 *
 * The image is north-up; `headingDeg` is the ground-track heading at closest approach, so a descending
 * Sentinel-2 pass (≈ 195°) scans from the top edge down, slightly leaning.
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
 * Cheap by construction (PERF-04): the per-frame work is canvas paint + one textContent write.
 * React renders at mount, at scan start, at the centre lock and at the end. The box size comes from a
 * ResizeObserver, never from layout reads inside paint().
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { DUR } from '@/lib/ease'
import { useApp } from '@/state/store'
import { Button, LiveDot, cx, palette, useReducedMotion } from '@/ui/system'
import { sceneClock } from '@/state/sceneClock'
import { awaitCountdown, useCaptureMoment } from './capture'
import { frontLine, lineLabel, motionVector, revealProgress, REVEAL_MS, scannedPolygon, sweepRange } from './lib/pushbroom'
import { loadPhoto } from './images'
import { markSeen } from './once'
import s from './PushbroomReveal.module.css'

export type RevealPhase = 'loading' | 'waiting' | 'revealing' | 'done' | 'error'

interface Props {
  src: string
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
const GLOW_PX = 8
const RASTER_PITCH = 4
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
  headingDeg,
  lines,
  alt,
  overlay,
  caption,
  acquiringNote,
  startAt = 'arrival',
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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lineRef = useRef<HTMLElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
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
   * The picture pre-scaled to the canvas (cover crop, device pixels), so every paint is a 1:1 blit (U-1). Drawing the
   * 1024 px element with high-quality smoothing cost ~25 ms per frame at 4× CPU, and its first draw (upload + mips)
   * 100–150 ms inside a ResizeObserver callback; the bitmap is made once (~25 ms, in an idle slot before the scan).
   */
  const bmpRef = useRef<{ bmp: ImageBitmap; W: number; H: number } | null>(null)
  const bmpPending = useRef<Promise<void> | null>(null)
  const dropBitmap = useCallback(() => {
    bmpRef.current?.bmp.close?.()
    bmpRef.current = null
    bmpPending.current = null
  }, [])
  useEffect(() => dropBitmap, [dropBitmap])

  /** Cover-fit crop of the source for a w×h box: a square crop in a 16:9 hero frame shows its centre (the place stays centred). */
  const coverCrop = (img: HTMLImageElement, w: number, h: number) => {
    const iw = img.naturalWidth || img.width
    const ih = img.naturalHeight || img.height
    const scale = Math.max(w / iw, h / ih)
    const sw = w / scale
    const sh = h / scale
    return { sx: (iw - sw) / 2, sy: (ih - sh) / 2, sw, sh }
  }

  /** Make the pre-scaled bitmap for the current size (resolves at once if it exists). Never rejects. */
  const ensureBitmap = useCallback((): Promise<void> => {
    const img = imgRef.current
    const { w, h } = sizeRef.current
    if (!img || !w || !h || typeof createImageBitmap !== 'function') return Promise.resolve()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = Math.round(w * dpr)
    const H = Math.round(h * dpr)
    const have = bmpRef.current
    if (have && have.W === W && have.H === H) return Promise.resolve()
    if (bmpPending.current) return bmpPending.current
    const { sx, sy, sw, sh } = coverCrop(img, w, h)
    const p = createImageBitmap(img, Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh), { resizeWidth: W, resizeHeight: H, resizeQuality: 'high' })
      .then((bmp) => {
        if (bmpPending.current !== p) return void bmp.close?.()
        bmpPending.current = null
        bmpRef.current?.bmp.close?.()
        bmpRef.current = { bmp, W, H }
      })
      .catch(() => {
        if (bmpPending.current === p) bmpPending.current = null
      })
    bmpPending.current = p
    return p
  }, [])

  /** Paint the image scanned up to progress p (0..1). */
  const paint = useCallback(
    (p: number) => {
      const cv = canvasRef.current
      const img = imgRef.current
      const { w, h } = sizeRef.current
      if (!cv || !img || !w || !h) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const W = Math.round(w * dpr)
      const H = Math.round(h * dpr)
      const T: number[] = [performance.now()]
      if (cv.width !== W || cv.height !== H) {
        cv.width = W
        cv.height = H
      }
      T.push(performance.now())
      // A CPU-backed canvas (U-1): a GPU-backed one makes the first paint (and every resize) wait on the GPU process,
      // which on a phone is busy drawing the globe (70–145 ms of main thread at 4× CPU). Each frame here is a small
      // blit plus a few paths; the compositor uploads the result.
      const ctx = cv.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      T.push(performance.now())
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      T.push(performance.now())
      ;((window as any).__pb ||= []).push({ p, T })
      ctx.imageSmoothingQuality = 'high'
      const draw = () => {
        const b = bmpRef.current
        if (b && b.W === W && b.H === H) {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.drawImage(b.bmp, 0, 0)
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        } else if (b) {
          // Resized since the bitmap was made (a new one is on its way): scale the old one, never the 1024 px source.
          ctx.drawImage(b.bmp, 0, 0, w, h)
        } else {
          const { sx, sy, sw, sh } = coverCrop(img, w, h)
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h)
        }
      }
      if (p >= 1) {
        draw()
        return
      }
      const d = motionVector(headingDeg)
      const [a, b] = sweepRange(w, h, d)
      const front = a + (b - a) * p
      const px = 1 / dpr

      // Not yet scanned: ink raster, hairlines parallel to the front at a 4px pitch.
      ctx.save()
      const ahead = scannedPolygon(w, h, { x: -d.x, y: -d.y }, -front)
      fillPoly(ctx, ahead, palette.ink2)
      ctx.clip()
      ctx.strokeStyle = 'rgba(236,232,224,0.06)'
      ctx.lineWidth = px
      ctx.beginPath()
      for (let sPos = front + RASTER_PITCH; sPos <= b + RASTER_PITCH; sPos += RASTER_PITCH) {
        const [l0, l1] = frontLine(w, h, d, sPos)
        ctx.moveTo(l0.x, l0.y)
        ctx.lineTo(l1.x, l1.y)
      }
      ctx.stroke()
      ctx.restore()
      T.push(performance.now())

      // Scanned part (none yet at 0: the waiting raster never touches the picture's pixels).
      if (p > 0) {
        ctx.save()
        const poly = scannedPolygon(w, h, d, front)
        tracePoly(ctx, poly)
        ctx.clip()
        draw()
        // Trailing glow just behind the front (DESIGN §5: ≈ 6px, 30 % → 0). Screen-blended so it reads
        // as light on dark terrain at 1× DPR, not as a tint lost in the antialiasing of the line.
        const g = ctx.createLinearGradient(d.x * front, d.y * front, d.x * (front - GLOW_PX), d.y * (front - GLOW_PX))
        g.addColorStop(0, 'rgba(255,106,26,0.42)')
        g.addColorStop(0.35, 'rgba(255,106,26,0.18)')
        g.addColorStop(1, 'rgba(255,106,26,0)')
        ctx.globalCompositeOperation = 'screen'
        fillPoly(ctx, scannedPolygon(w, h, d, front, GLOW_PX), g)
        ctx.restore()
      }

      // Scan front: a signal line with a 1px bone core (a hot read head, not a crack in a JPEG).
      const [l0, l1] = frontLine(w, h, d, front)
      ctx.lineWidth = 2
      ctx.strokeStyle = palette.signal
      ctx.beginPath()
      ctx.moveTo(l0.x, l0.y)
      ctx.lineTo(l1.x, l1.y)
      ctx.stroke()
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(236,232,224,0.6)'
      ctx.beginPath()
      ctx.moveTo(l0.x, l0.y)
      ctx.lineTo(l1.x, l1.y)
      ctx.stroke()
      T.push(performance.now())
    },
    [headingDeg],
  )

  // Size from a ResizeObserver only: its first callback arrives after layout, so mounting never forces
  // a synchronous layout of the panel inside React's commit (that read alone cost 110 ms at 4× CPU on
  // the results handoff). paint() waits for a size; the observer repaints at the current progress.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    if (typeof ResizeObserver === 'undefined') {
      sizeRef.current = { w: box.clientWidth, h: box.clientHeight }
      return
    }
    let idle = 0
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect
      sizeRef.current = { w: r.width, h: r.height }
      paint(progressRef.current)
      // A picture already on the canvas at another size: a new pre-scaled bitmap in an idle slot, then repaint.
      if (imgRef.current && bmpRef.current && progressRef.current > 0) {
        cancelIdle(idle)
        idle = whenIdle(() => void ensureBitmap().then(() => paint(progressRef.current)))
      }
    })
    ro.observe(box)
    return () => {
      ro.disconnect()
      cancelIdle(idle)
    }
  }, [paint, ensureBitmap])

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
    imgRef.current = null
    dropBitmap()
    let idle = 0
    progressRef.current = 0
    setCentreLocked(false)
    setSlow(false)
    setP('loading')
    if (lineRef.current) lineRef.current.textContent = lineLabel(0)
    const slowTimer = window.setTimeout(() => alive && setSlow(true), 4500)

    const finish = () => {
      progressRef.current = 1
      paint(1)
      if (lineRef.current) lineRef.current.textContent = lineLabel(lines)
      setCentreLocked(true)
      setP('done')
    }
    const run = () => {
      if (!alive) return
      if (seenKey) markSeen(seenKey)
      useApp.getState().holdMotion(DUR.pushbroom + 200)
      cancelIdle(idle)
      // Every frame of the scan blits the pre-scaled picture (usually made already, in the wait).
      void ensureBitmap().then(() => alive && scan())
    }
    const scan = () => {
      if (reduced) {
        finish()
        return
      }
      setP('revealing')
      // The centre lock is a render only when an overlay needs it (≤ 3 renders per reveal otherwise).
      let locked = !hasOverlay
      const start = performance.now()
      const tick = (now: number) => {
        if (!alive) return
        const p = revealProgress(now - start, REVEAL_MS)
        progressRef.current = p
        paint(p)
        if (lineRef.current) lineRef.current.textContent = lineLabel(Math.round(p * lines))
        if (!locked && p >= 0.5) {
          locked = true
          setCentreLocked(true)
        }
        if (p < 1) raf = requestAnimationFrame(tick)
        else setP('done')
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
      .then((img) => {
        if (!alive) return
        window.clearTimeout(slowTimer)
        imgRef.current = img
        if (instant) return void ensureBitmap().then(() => alive && finish())
        paint(0)
        setP('waiting')
        // The scan's pre-scaled picture, made while it waits (one ~25 ms slice at 4× CPU, off the critical path).
        idle = whenIdle(() => void ensureBitmap())
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
      cancelIdle(idle)
      cancelAnimationFrame(raf)
      window.clearTimeout(poll)
      window.clearTimeout(slowTimer)
    }
    // `attempt` re-runs the load on retry. `instant`/`startAt` are read at start only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, lines, reduced, paint, setP, attempt, ensureBitmap, dropBitmap])

  const shown = phase === 'revealing' || phase === 'done'

  return (
    <figure className={cx(s.figure, className)}>
      <div ref={boxRef} className={cx(s.frame, phase !== 'done' && s.loading, phase === 'error' && s.errored, frameClassName)}>
        <canvas
          ref={canvasRef}
          className={cx(s.canvas, reduced || fade ? s.fade : s.cut, (shown || phase === 'waiting') && s.on, dim === 'cloud' && s.dimCloud, dim === 'overcast' && s.dim)}
          role="img"
          aria-label={alt}
        />
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
        <span className={cx(s.scanChip, phase === 'revealing' && s.scanChipOn)} aria-hidden>
          {phase === 'revealing' ? <LiveDot className={s.dot} /> : null}
          Line <b ref={lineRef}>{lineLabel(0)}</b> → {lineLabel(lines)}
        </span>
        {startAt === 'capture' && tc !== undefined ? (
          <span className={cx(s.awaitChip, phase === 'waiting' && s.scanChipOn)} aria-hidden>
            Awaiting pass
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

/** requestIdleCallback with a short deadline (a fallback timer where it is missing); returns a handle for cancelIdle. */
function whenIdle(cb: () => void): number {
  if (typeof requestIdleCallback === 'function') return requestIdleCallback(cb, { timeout: 400 })
  return -window.setTimeout(cb, 60)
}
function cancelIdle(id: number) {
  if (!id) return
  if (id < 0) window.clearTimeout(-id)
  else if (typeof cancelIdleCallback === 'function') cancelIdleCallback(id)
}

function tracePoly(ctx: CanvasRenderingContext2D, poly: { x: number; y: number }[]) {
  ctx.beginPath()
  ctx.moveTo(poly[0].x, poly[0].y)
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y)
  ctx.closePath()
}

function fillPoly(ctx: CanvasRenderingContext2D, poly: { x: number; y: number }[], fill: string | CanvasGradient) {
  tracePoly(ctx, poly)
  ctx.fillStyle = fill
  ctx.fill()
}
