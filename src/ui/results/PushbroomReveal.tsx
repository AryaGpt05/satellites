/**
 * The signature moment (DESIGN §5): a captured image is revealed line by line in the satellite's
 * along-track direction, the way a pushbroom sensor actually builds it. A 1px signal scan line leads
 * with a faint 6px trailing glow; a mono counter reads LINE 0000 → 1024. ≈ 1.6 s, linear (a pushbroom
 * scans at a constant rate). Reduced motion: a plain fade.
 *
 * The image is north-up; `headingDeg` is the ground-track heading at closest approach, so a descending
 * Sentinel-2 pass (≈ 195°) scans from the top edge down, slightly leaning.
 *
 * States: acquiring (hairline frame, mono ACQUIRING…) → revealing → done; or error (honest message +
 * retry). The image is fetched with preloadImage (crossOrigin anonymous, decoded off-thread, cached).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { preloadImage } from '@/imagery'
import { Button, LiveDot, cx, palette, useReducedMotion } from '@/ui/system'
import { frontLine, lineLabel, motionVector, revealProgress, REVEAL_MS, scannedPolygon, sweepRange } from './lib/pushbroom'
import s from './PushbroomReveal.module.css'

type Phase = 'loading' | 'revealing' | 'done' | 'error'

interface Props {
  src: string
  headingDeg: number
  /** Image lines (px height of the render) for the counter */
  lines: number
  alt: string
  /** Overlay drawn above the image (reticle, labels); receives whether the scan has passed the centre */
  overlay?: (state: { centreLocked: boolean; phase: Phase }) => ReactNode
  /** Caption left of the counter */
  caption?: ReactNode
  /** Slow-network copy under ACQUIRING… */
  acquiringNote?: string
  className?: string
  onPhase?: (p: Phase) => void
}

const GLOW_PX = 6

export function PushbroomReveal({ src, headingDeg, lines, alt, overlay, caption, acquiringNote, className, onPhase }: Props) {
  const reduced = useReducedMotion()
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const progressRef = useRef(0)
  const [phase, setPhase] = useState<Phase>('loading')
  const [line, setLine] = useState(0)
  const [slow, setSlow] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const setP = useCallback(
    (p: Phase) => {
      setPhase(p)
      onPhase?.(p)
    },
    [onPhase],
  )

  /** Paint the image scanned up to progress p (0..1), with the scan line + glow while 0 < p < 1. */
  const paint = useCallback(
    (p: number) => {
      const cv = canvasRef.current
      const box = boxRef.current
      const img = imgRef.current
      if (!cv || !box || !img) return
      const w = box.clientWidth
      const h = box.clientHeight
      if (!w || !h) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const W = Math.round(w * dpr)
      const H = Math.round(h * dpr)
      if (cv.width !== W || cv.height !== H) {
        cv.width = W
        cv.height = H
      }
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.imageSmoothingQuality = 'high'
      if (p >= 1) {
        ctx.drawImage(img, 0, 0, w, h)
        return
      }
      const d = motionVector(headingDeg)
      const [a, b] = sweepRange(w, h, d)
      const front = a + (b - a) * p
      // scanned part
      ctx.save()
      const poly = scannedPolygon(w, h, d, front)
      ctx.beginPath()
      ctx.moveTo(poly[0].x, poly[0].y)
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y)
      ctx.closePath()
      ctx.clip()
      ctx.drawImage(img, 0, 0, w, h)
      // trailing glow (6px, 30% → 0) just behind the front
      const g = ctx.createLinearGradient(d.x * front, d.y * front, d.x * (front - GLOW_PX), d.y * (front - GLOW_PX))
      g.addColorStop(0, 'rgba(255,106,26,0.30)')
      g.addColorStop(1, 'rgba(255,106,26,0)')
      const band = scannedPolygon(w, h, d, front, GLOW_PX)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(band[0].x, band[0].y)
      for (let i = 1; i < band.length; i++) ctx.lineTo(band[i].x, band[i].y)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
      // 1px scan line
      const [l0, l1] = frontLine(w, h, d, front)
      ctx.strokeStyle = palette.signal
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(l0.x, l0.y)
      ctx.lineTo(l1.x, l1.y)
      ctx.stroke()
    },
    [headingDeg],
  )

  // Load → reveal.
  useEffect(() => {
    let alive = true
    let raf = 0
    const ctl = new AbortController()
    imgRef.current = null
    progressRef.current = 0
    setLine(0)
    setSlow(false)
    setP('loading')
    const slowTimer = window.setTimeout(() => alive && setSlow(true), 4500)
    preloadImage(src, { signal: ctl.signal })
      .then((img) => {
        if (!alive) return
        window.clearTimeout(slowTimer)
        imgRef.current = img
        if (reduced) {
          progressRef.current = 1
          paint(1)
          setLine(lines)
          setP('done')
          return
        }
        setP('revealing')
        const start = performance.now()
        const tick = (now: number) => {
          if (!alive) return
          const p = revealProgress(now - start, REVEAL_MS)
          progressRef.current = p
          paint(p)
          setLine(Math.round(p * lines))
          if (p < 1) raf = requestAnimationFrame(tick)
          else setP('done')
        }
        raf = requestAnimationFrame(tick)
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
      window.clearTimeout(slowTimer)
    }
    // `attempt` re-runs the load on retry.
  }, [src, lines, reduced, paint, setP, attempt])

  // Repaint on resize (keeps the canvas crisp; holds the current progress).
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => paint(progressRef.current))
    ro.observe(box)
    return () => ro.disconnect()
  }, [paint])

  const centreLocked = phase === 'done' || (phase === 'revealing' && line >= lines / 2)

  return (
    <figure className={cx(s.figure, className)}>
      <div ref={boxRef} className={cx(s.frame, phase === 'loading' && s.loading, phase === 'error' && s.errored)}>
        <canvas
          ref={canvasRef}
          className={cx(s.canvas, reduced && s.fade, (phase === 'revealing' || phase === 'done') && s.on)}
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
        {/* The counter rides on the image while it scans (the caption below may be off-screen). */}
        <span className={cx(s.scanChip, phase === 'revealing' && s.scanChipOn)} aria-hidden>
          <LiveDot className={s.dot} />
          Line <b>{lineLabel(line)}</b> → {lineLabel(lines)}
        </span>
      </div>
      <figcaption className={s.caption}>
        <span className={s.counter} aria-hidden>
          Line <b>{lineLabel(phase === 'loading' || phase === 'error' ? 0 : line)}</b> → {lineLabel(lines)}
        </span>
        {caption ? <span className={s.captionRest}>{caption}</span> : null}
      </figcaption>
    </figure>
  )
}
