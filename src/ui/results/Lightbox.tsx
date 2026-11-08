/**
 * The lightbox (owner B + B2): the same viewer on every device, a full-viewport ink layer over the globe and
 * the panel (below the share sheet).
 *
 *   phones   edge to edge (safe areas respected). Swipe left / right between photos, pinch to zoom (1×–6×) and
 *            pan, double-tap zooms 2.5× at the tap and back, swipe down dismisses with an interactive drag
 *            (the photo follows the finger, the backdrop fades with distance; past a threshold or a flick it
 *            closes, otherwise it eases back). Pointer Events, touch-action none, transforms only.
 *   laptops  the photo up to ~85vh, a metadata strip and a filmstrip. Wheel / trackpad pinch zooms around
 *            the cursor, drag pans, double-click toggles 2.5×, ← → move, + − 0 zoom, Esc / ✕ / F close.
 *
 * More detail when expanded: Sentinel-2 / Landsat load a 2048 px render of the same area (lib/photos
 * hiResUrl) once the opening motion is over; the decoded card image shows at once and the sharper one
 * crossfades in (200 ms) when decoded. The resolution ("10 m / pixel") and a live scale bar ride on the
 * frame; the reticle stays on the place at any zoom.
 *
 * Open / close: the photo grows from its exact rect in the panel (FLIP, 360 ms ease-out) and shrinks back to
 * the rect of whichever photo is current on close; the backdrop fades. Reduced motion: a 160 ms fade.
 * role="dialog" aria-modal, focus trapped and returned, the counter announced ("Photo 3 of 27").
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { Pass } from '@/types'
import { Button, Glyph, cx, prefersReducedMotion } from '@/ui/system'
import { Ago } from './Ago'
import { credit, galleryCtl } from './Gallery'
import { Mark } from './Mark'
import { PushbroomReveal } from './PushbroomReveal'
import { Reticle } from './Reticle'
import { coordsOf, seenKeyOf } from './PhotoFrame'
import { selectQuietly } from './actions'
import { useGallery } from './gallery'
import { decodedPhoto, loadPhoto } from './images'
import { cardSpec, cardUrl, cropWidthKm, filterPhotos, hiResUrl, thumbUrl, type Photo } from './lib/photos'
import { productLabel, scaleBarKm, sensorName } from './lib/captures'
import { dec1, int } from './lib/copy'
import { fmtLocalDay, fmtLocalTime, zoneAbbr } from './lib/time'
import type { ResultsModel } from './model'
import { wasSeen } from './once'
import s from './Lightbox.module.css'

const MAX_ZOOM = 6
const DOUBLE_ZOOM = 2.5
const OPEN_MS = 360
const CLOSE_MS = 280
const FADE_MS = 160
const NAV_MS = 260
const GAP = 24

interface Layout {
  side: number
  left: number
  top: number
}

function computeLayout(mobile: boolean): Layout {
  const W = window.innerWidth
  const H = window.innerHeight
  if (mobile) {
    const topH = 56
    const metaH = 92
    const side = Math.max(160, Math.min(W, H - topH - metaH))
    return { side, left: (W - side) / 2, top: topH + Math.max(0, (H - topH - metaH - side) / 2) }
  }
  const topH = 64
  const metaH = 64
  const filmH = 76
  const side = Math.max(240, Math.min(H - topH - metaH - filmH - 16, W - 2 * 96, Math.round(H * 0.85)))
  return { side, left: (W - side) / 2, top: topH + Math.max(0, (H - topH - metaH - filmH - side) / 2) }
}

export function Lightbox({ model, mobile, onReplay }: { model: ResultsModel; mobile: boolean; onReplay?: (p: Pass) => void }) {
  const lb = useGallery((g) => g.lightbox)
  if (!lb) return null
  return createPortal(<Viewer key={lb.key + (lb.from ? '' : '-')} model={model} mobile={mobile} startKey={lb.key} from={lb.from} onReplay={onReplay} />, document.body)
}

interface ViewerProps {
  model: ResultsModel
  mobile: boolean
  startKey: string
  from: HTMLElement | null
  onReplay?: (p: Pass) => void
}

function Viewer({ model, mobile, startKey, from, onReplay }: ViewerProps) {
  const filter = useGallery((g) => g.filter)
  const items = useMemo(() => {
    const list = filterPhotos(model.photos, filter)
    return list.some((p) => p.key === startKey) ? list : model.photos
  }, [model.photos, filter, startKey])
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex((p) => p.key === startKey)))
  const indexRef = useRef(index)
  indexRef.current = index
  const [layout, setLayout] = useState<Layout>(() => computeLayout(mobile))
  const [opened, setOpened] = useState(false)
  const [closing, setClosing] = useState(false)
  // The photo the viewer opened on reveals (pushbroom) only if it was never shown before.
  const [revealKey] = useState(() => (wasSeen(seenKeyOf(items[index] ?? items[0])) ? '' : startKey))

  const rootRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef<HTMLDivElement>(null)
  const reticleRef = useRef<HTMLSpanElement>(null)
  const barRef = useRef<HTMLSpanElement>(null)
  const barTextRef = useRef<HTMLSpanElement>(null)
  const zoomTextRef = useRef<HTMLSpanElement>(null)
  const chromeRef = useRef<HTMLDivElement[]>([])
  const z = useRef({ s: 1, x: 0, y: 0 })
  const anim = useRef(0)
  const reduced = prefersReducedMotion()
  const photo = items[index]
  const n = items.length

  // ── zoom / pan ──────────────────────────────────────────────────────────────────────────
  const apply = useCallback(() => {
    const { s: k, x, y } = z.current
    const zl = zoomRef.current
    if (zl) zl.style.transform = k === 1 && !x && !y ? '' : `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${k.toFixed(4)})`
    if (reticleRef.current) reticleRef.current.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
    const p = items[indexRef.current]
    const side = layoutRef.current.side
    if (p && barRef.current && barTextRef.current && side) {
      const visKm = cropWidthKm(p.capture) / k
      const km = scaleBarKm(visKm)
      barRef.current.style.width = `${Math.round((km / visKm) * side)}px`
      const txt = `${km >= 1 ? int(km) : km} km`
      if (barTextRef.current.textContent !== txt) barTextRef.current.textContent = txt
    }
    if (zoomTextRef.current) zoomTextRef.current.textContent = `${k.toFixed(1)}×`
    const box = boxRef.current
    if (box) box.dataset.zoomed = k > 1.001 ? 'true' : 'false'
  }, [items])
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const clampPan = () => {
    const m = ((z.current.s - 1) * layoutRef.current.side) / 2
    z.current.x = Math.max(-m, Math.min(m, z.current.x))
    z.current.y = Math.max(-m, Math.min(m, z.current.y))
  }
  /** Zoom to `k` keeping the content point under (px, py) (box-centre coordinates) where it is. */
  const zoomAt = (k: number, px: number, py: number) => {
    const c = z.current
    const nk = Math.max(1, Math.min(MAX_ZOOM, k))
    c.x = px - (px - c.x) * (nk / c.s)
    c.y = py - (py - c.y) * (nk / c.s)
    c.s = nk
    if (nk === 1) c.x = c.y = 0
    clampPan()
    apply()
  }
  const tweenZoom = (k: number, px = 0, py = 0) => {
    cancelAnimationFrame(anim.current)
    const a = { ...z.current }
    zoomAt(k, px, py)
    const b = { ...z.current }
    if (reduced) return
    z.current = { ...a }
    const t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 240)
      const e = 1 - Math.pow(1 - t, 3)
      z.current = { s: a.s + (b.s - a.s) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e }
      apply()
      if (t < 1) anim.current = requestAnimationFrame(step)
    }
    anim.current = requestAnimationFrame(step)
  }
  const resetZoom = (animate = true) => (animate ? tweenZoom(1) : ((z.current = { s: 1, x: 0, y: 0 }), apply()))

  // ── layout ──────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => setLayout(computeLayout(mobile))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [mobile])
  useLayoutEffect(() => apply(), [apply, layout, index])

  // ── open: FLIP from the panel's frame ───────────────────────────────────────────────────
  useLayoutEffect(() => {
    const box = boxRef.current
    const scrim = scrimRef.current
    if (!box || !scrim) return
    const chrome = chromeRef.current.filter(Boolean)
    const done = () => setOpened(true)
    if (reduced || !from || !from.isConnected) {
      const a = [rootRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced ? FADE_MS : 220, easing: 'linear' })]
      if (a[0]) a[0].onfinish = done
      else done()
      return
    }
    const r = from.getBoundingClientRect()
    const L = layoutRef.current
    const k = r.width / L.side
    const insetY = Math.max(0, (L.side - r.height / k) / 2)
    const dx = r.left + r.width / 2 - (L.left + L.side / 2)
    const dy = r.top + r.height / 2 - (L.top + L.side / 2)
    const a = box.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${k})`, clipPath: `inset(${insetY}px 0 ${insetY}px 0)` },
        { transform: 'none', clipPath: 'inset(0 0 0 0)' },
      ],
      { duration: OPEN_MS, easing: 'cubic-bezier(.2,0,0,1)' },
    )
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'linear' })
    for (const el of chrome) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 140, easing: 'linear', fill: 'backwards' })
    a.onfinish = done
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── close: shrink back to whichever photo is current ────────────────────────────────────
  const closingRef = useRef(false)
  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    cancelAnimationFrame(anim.current)
    const p = items[indexRef.current]
    // The panel follows: the gallery jumps to this photo (the pass view selects its pass quietly).
    if (p) {
      useGallery.getState().setKey(p.key, true)
      galleryCtl.current?.jump(p.key)
      if (p.pass && document.querySelector('[data-gallery="detail"]')) selectQuietly(p.pass)
    }
    const finish = () => {
      useGallery.getState().closeLightbox()
      const target = p ? document.querySelector<HTMLElement>(`[data-photo-frame="${CSS.escape(p.key)}"] button`) : null
      ;(target ?? from?.querySelector<HTMLElement>('button') ?? from)?.focus?.({ preventScroll: true })
    }
    const box = boxRef.current
    const scrim = scrimRef.current
    const chrome = chromeRef.current.filter(Boolean)
    // Two frames: the gallery has scrolled to the photo before its rect is read.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = p ? document.querySelector<HTMLElement>(`[data-photo-frame="${CSS.escape(p.key)}"]`) : null
        const r = el?.getBoundingClientRect()
        const vis = !!r && r.width > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth
        if (!box || !scrim || reduced || !vis || !r) {
          const a = rootRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? FADE_MS : 200, easing: 'linear', fill: 'forwards' })
          if (a) a.onfinish = finish
          else finish()
          return
        }
        const L = layoutRef.current
        const k = r.width / L.side
        const insetY = Math.max(0, (L.side - r.height / k) / 2)
        const dx = r.left + r.width / 2 - (L.left + L.side / 2)
        const dy = r.top + r.height / 2 - (L.top + L.side / 2)
        // From wherever the photo is now (a dismiss drag may have moved it), zoom easing back to 1×.
        const cur = getComputedStyle(box).transform
        const opts = { duration: CLOSE_MS, easing: 'cubic-bezier(.6,0,.2,1)', fill: 'forwards' as const }
        const a = box.animate(
          [
            { transform: cur === 'none' ? 'none' : cur, clipPath: 'inset(0 0 0 0)' },
            { transform: `translate(${dx}px, ${dy}px) scale(${k})`, clipPath: `inset(${insetY}px 0 ${insetY}px 0)` },
          ],
          opts,
        )
        zoomRef.current?.animate([{ transform: zoomRef.current.style.transform || 'none' }, { transform: 'none' }], opts)
        scrim.animate([{ opacity: Number(getComputedStyle(scrim).opacity) || 1 }, { opacity: 0 }], { ...opts, easing: 'linear' })
        for (const c of chrome) c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'linear', fill: 'forwards' })
        a.onfinish = finish
      }),
    )
  }, [items, from, reduced])

  // ── navigate ────────────────────────────────────────────────────────────────────────────
  const navigating = useRef(false)
  const go = useCallback(
    (dir: 1 | -1) => {
      const i = indexRef.current + dir
      if (i < 0 || i >= n || navigating.current) return
      const strip = stripRef.current
      resetZoom(false)
      if (!strip || reduced) {
        setIndex(i)
        return
      }
      navigating.current = true
      const cur = new DOMMatrixReadOnly(getComputedStyle(strip).transform).m41 || 0
      const to = -dir * (layoutRef.current.side + GAP)
      const a = strip.animate([{ transform: `translateX(${cur}px)` }, { transform: `translateX(${to}px)` }], { duration: NAV_MS, easing: 'cubic-bezier(.2,0,0,1)', fill: 'forwards' })
      a.onfinish = () => {
        navigating.current = false
        setIndex(i)
        // The new index lays the slides out around 0 in the same commit (layout effect below).
        requestAnimationFrame(() => a.cancel())
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [n, reduced],
  )
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (strip) strip.style.transform = ''
    for (const a of strip?.getAnimations() ?? []) a.cancel()
  }, [index])
  const goTo = (i: number) => {
    if (i === indexRef.current) return
    resetZoom(false)
    setIndex(Math.max(0, Math.min(n - 1, i)))
  }

  // ── keys (capture phase: the app's Esc / ← → never also act) and the focus trap ─────────
  const actions = useRef({ close, go, tweenZoom, resetZoom })
  actions.current = { close, go, tweenZoom, resetZoom }
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    rootRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      const A = actions.current
      const k = e.key
      let handled = true
      if (k === 'Escape' || k === 'f' || k === 'F') A.close()
      else if (k === 'ArrowLeft') A.go(-1)
      else if (k === 'ArrowRight') A.go(1)
      else if (k === '+' || k === '=') A.tweenZoom(z.current.s * 1.6)
      else if (k === '-' || k === '_') A.tweenZoom(z.current.s / 1.6, 0, 0)
      else if (k === '0') A.resetZoom()
      else if (k === 'Tab') trapFocus(e, rootRef.current)
      else if (k === ' ' && !(e.target as HTMLElement | null)?.closest?.('button')) {
        /* Space: nothing behind the viewer (the replay) reacts while it is open */
      } else handled = false
      if (handled) {
        e.stopPropagation()
        if (k !== 'Tab') e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (!closingRef.current) prev?.focus?.({ preventScroll: true })
    }
  }, [])

  // ── pointers: wheel zoom, drag pan, double tap / click, swipe between photos, swipe down to dismiss ──
  useEffect(() => {
    const box = boxRef.current
    const root = rootRef.current
    if (!box || !root) return
    const local = (cx: number, cy: number) => {
      const L = layoutRef.current
      return { x: cx - (L.left + L.side / 2), y: cy - (L.top + L.side / 2) }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (closingRef.current) return
      cancelAnimationFrame(anim.current)
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))
      const p = local(e.clientX, e.clientY)
      zoomAt(z.current.s * f, p.x, p.y)
    }
    box.addEventListener('wheel', onWheel, { passive: false })

    const pts = new Map<number, { x: number; y: number }>()
    let mode: 'none' | 'pan' | 'swipe' | 'dismiss' | 'pinch' | 'pending' = 'none'
    let start = { x: 0, y: 0, t: 0, zx: 0, zy: 0 }
    let pinch = { d: 1, s: 1, mx: 0, my: 0, x: 0, y: 0 }
    let samples: { t: number; x: number; y: number }[] = []
    let lastTap = { t: 0, x: 0, y: 0 }
    const strip = stripRef.current
    const scrim = scrimRef.current
    const chrome = () => chromeRef.current.filter(Boolean)
    const mid = () => {
      const [a, b] = [...pts.values()]
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }
    }
    const down = (e: PointerEvent) => {
      if (closingRef.current || (e.pointerType === 'mouse' && e.button !== 0)) return
      if ((e.target as Element).closest?.('button')) return
      cancelAnimationFrame(anim.current)
      box.setPointerCapture?.(e.pointerId)
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pts.size === 2) {
        const m = mid()
        const p = local(m.x, m.y)
        pinch = { d: m.d, s: z.current.s, mx: p.x, my: p.y, x: z.current.x, y: z.current.y }
        mode = 'pinch'
        if (strip) strip.style.transform = ''
        return
      }
      start = { x: e.clientX, y: e.clientY, t: e.timeStamp, zx: z.current.x, zy: z.current.y }
      samples = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }]
      mode = z.current.s > 1.001 ? 'pan' : 'pending'
      if (mode === 'pan') box.dataset.grabbing = 'true'
    }
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY })
      if (samples.length > 6) samples.shift()
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      if (mode === 'pinch' && pts.size >= 2) {
        const m = mid()
        const p = local(m.x, m.y)
        const k = Math.max(1, Math.min(MAX_ZOOM, pinch.s * (m.d / pinch.d)))
        // The content point under the first midpoint follows the fingers.
        z.current.s = k
        z.current.x = p.x - ((pinch.mx - pinch.x) / pinch.s) * k
        z.current.y = p.y - ((pinch.my - pinch.y) / pinch.s) * k
        clampPan()
        apply()
        return
      }
      if (mode === 'pan') {
        z.current.x = start.zx + dx
        z.current.y = start.zy + dy
        clampPan()
        apply()
        return
      }
      if (mode === 'pending') {
        if (Math.hypot(dx, dy) < 8 || e.pointerType === 'mouse') return
        mode = Math.abs(dx) > Math.abs(dy) ? 'swipe' : dy > 0 ? 'dismiss' : 'none'
      }
      if (mode === 'swipe' && strip) {
        const i = indexRef.current
        // Rubber band at the ends.
        const edge = (dx > 0 && i === 0) || (dx < 0 && i === n - 1)
        strip.style.transform = `translateX(${(edge ? dx / 3 : dx).toFixed(1)}px)`
      } else if (mode === 'dismiss') {
        const d = Math.max(0, dy)
        const k = 1 - Math.min(0.25, d / 1600)
        box.style.transform = `translate(${(dx * 0.6).toFixed(1)}px, ${d.toFixed(1)}px) scale(${k.toFixed(4)})`
        const fade = Math.min(1, d / (layoutRef.current.side * 0.9))
        if (scrim) scrim.style.opacity = String(1 - fade * 0.85)
        for (const c of chrome()) c.style.opacity = String(Math.max(0, 1 - fade * 3))
      }
    }
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      pts.delete(e.pointerId)
      box.dataset.grabbing = 'false'
      if (mode === 'pinch') {
        if (pts.size === 1) {
          // One finger left: carry on panning from here.
          const [p] = [...pts.values()]
          start = { x: p.x, y: p.y, t: e.timeStamp, zx: z.current.x, zy: z.current.y }
          mode = z.current.s > 1.001 ? 'pan' : 'none'
        } else mode = 'none'
        return
      }
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      const first = samples[0]
      const last = samples[samples.length - 1]
      const dt = Math.max(1, last.t - first.t)
      const vx = (last.x - first.x) / dt
      const vy = (last.y - first.y) / dt
      const m = mode
      mode = 'none'
      if (m === 'swipe' && strip) {
        const i = indexRef.current
        const side = layoutRef.current.side
        const dir: 1 | -1 = dx < 0 ? 1 : -1
        const next = i + dir
        if (next >= 0 && next < n && (Math.abs(dx) > side * 0.22 || Math.abs(vx) > 0.45)) {
          actions.current.go(dir)
        } else {
          const cur = new DOMMatrixReadOnly(getComputedStyle(strip).transform).m41 || 0
          strip.animate([{ transform: `translateX(${cur}px)` }, { transform: 'translateX(0px)' }], { duration: 240, easing: 'cubic-bezier(.2,0,0,1)' })
          strip.style.transform = ''
        }
        return
      }
      if (m === 'dismiss') {
        if (dy > 110 || vy > 0.55) {
          actions.current.close()
          return
        }
        const cur = box.style.transform
        box.style.transform = ''
        box.animate([{ transform: cur }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,0,0,1)' })
        if (scrim) {
          const o = scrim.style.opacity
          scrim.style.opacity = ''
          scrim.animate([{ opacity: o }, { opacity: 1 }], { duration: 240, easing: 'linear' })
        }
        for (const c of chrome()) c.style.opacity = ''
        return
      }
      // A tap: double-tap (touch) zooms in at the point or back out.
      if (Math.hypot(dx, dy) < 10 && e.timeStamp - start.t < 300 && e.pointerType !== 'mouse') {
        if (e.timeStamp - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 32) {
          lastTap.t = 0
          const p = local(e.clientX, e.clientY)
          if (z.current.s > 1.001) tweenZoom(1)
          else tweenZoom(DOUBLE_ZOOM, p.x, p.y)
        } else lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY }
      }
    }
    const onDbl = (e: MouseEvent) => {
      const p = local(e.clientX, e.clientY)
      if (z.current.s > 1.001) tweenZoom(1)
      else tweenZoom(DOUBLE_ZOOM, p.x, p.y)
    }
    box.addEventListener('pointerdown', down)
    box.addEventListener('pointermove', move)
    box.addEventListener('pointerup', up)
    box.addEventListener('pointercancel', up)
    box.addEventListener('dblclick', onDbl)
    return () => {
      box.removeEventListener('wheel', onWheel)
      box.removeEventListener('pointerdown', down)
      box.removeEventListener('pointermove', move)
      box.removeEventListener('pointerup', up)
      box.removeEventListener('pointercancel', up)
      box.removeEventListener('dblclick', onDbl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n])

  // Keep the gallery behind in step (it is under the scrim; the close shrinks into it).
  useEffect(() => {
    const p = items[index]
    if (p && opened) useGallery.getState().setKey(p.key, true)
  }, [index, items, opened])

  if (!photo) return null
  const meta = model.meta(photo.pass?.norad ?? photo.capture.norad ?? 0)
  const windowItems = items.filter((p) => !!p.pass)
  const pos = photo.pass ? windowItems.indexOf(photo) + 1 : 0
  const counter = photo.pass ? `${pos} / ${windowItems.length}` : 'Last clear look'
  const spoken = photo.pass ? `Photo ${pos} of ${windowItems.length}` : 'The last clear look, from before this week'
  const side = layout.side
  const boxStyle: CSSProperties = { left: layout.left, top: layout.top, width: side, height: side }
  const setChrome = (i: number) => (el: HTMLDivElement | null) => {
    if (el) chromeRef.current[i] = el
  }

  return (
    <div ref={rootRef} className={cx(s.root, mobile && s.mobile, closing && s.closing)} role="dialog" aria-modal="true" aria-label="Photos" tabIndex={-1}>
      <div ref={scrimRef} className={s.scrim} onClick={close} />

      <div ref={setChrome(0)} className={s.top}>
        <span className={s.counter}>
          {counter}
          <span className="sr-only" aria-live="polite">
            {spoken}
          </span>
        </span>
        {!mobile ? (
          <span className={s.zoomCtl}>
            <button type="button" className={s.ctl} onClick={() => tweenZoom(z.current.s / 1.6)} aria-label="Zoom out" title="Zoom out (−)">
              −
            </button>
            <span ref={zoomTextRef} className={s.zoomText}>
              1.0×
            </span>
            <button type="button" className={s.ctl} onClick={() => tweenZoom(z.current.s * 1.6)} aria-label="Zoom in" title="Zoom in (+)">
              +
            </button>
          </span>
        ) : null}
        <button type="button" className={s.close} onClick={close} aria-label="Close the photo viewer" title="Close (Esc)">
          <Glyph name="close" size={14} />
        </button>
      </div>

      <div ref={boxRef} className={s.box} style={boxStyle} data-zoomed="false">
        <div ref={stripRef} className={s.strip}>
          {[-1, 0, 1].map((d) => {
            const p = items[index + d]
            if (!p) return null
            return (
              <div key={p.key} className={s.slide} style={{ transform: `translateX(${d * (side + GAP)}px)` }} aria-hidden={d !== 0 || undefined}>
                <div ref={d === 0 ? zoomRef : undefined} className={s.zoom}>
                  <LbPhoto photo={p} model={model} hires={opened && d === 0} reveal={p.key === revealKey} />
                </div>
              </div>
            )
          })}
        </div>
        <span ref={reticleRef} className={s.reticle}>
          <Reticle size={mobile ? 44 : 56} />
        </span>
        <span className={cx(s.chip, s.tl)}>
          {meta.name} · {sensorName(photo.capture)}
        </span>
        <span className={cx(s.chip, s.tr)}>{int(photo.capture.gsdM)} m / pixel</span>
        <span className={s.scale}>
          <span ref={barRef} className={s.scaleBar} />
          <span ref={barTextRef} className={s.scaleText} />
        </span>
        <span className={cx(s.chip, s.br)} aria-hidden>
          <svg width="8" height="10" viewBox="0 0 8 10">
            <path d="M4 0.5 7.5 9.5 4 7.2 0.5 9.5Z" fill="currentColor" />
          </svg>
          N
        </span>
      </div>

      {!mobile ? (
        <>
          <button
            type="button"
            className={cx(s.arrow, s.prev)}
            onClick={() => go(-1)}
            disabled={index <= 0}
            aria-label="Previous photo"
            ref={(el) => {
              if (el) chromeRef.current[3] = el as unknown as HTMLDivElement
            }}
          >
            <Mark name="chevron-left" size={16} />
          </button>
          <button
            type="button"
            className={cx(s.arrow, s.next)}
            onClick={() => go(1)}
            disabled={index >= n - 1}
            aria-label="Next photo"
            ref={(el) => {
              if (el) chromeRef.current[4] = el as unknown as HTMLDivElement
            }}
          >
            <Mark name="chevron-right" size={16} />
          </button>
        </>
      ) : null}

      <div ref={setChrome(1)} className={s.meta} style={{ top: layout.top + side + 12, left: mobile ? 16 : layout.left, width: mobile ? undefined : side }}>
        <MetaStrip photo={photo} model={model} cover={model.cover?.photo.key === photo.key ? model.cover.why : undefined} />
        {photo.pass && onReplay ? (
          <Button
            size="sm"
            onClick={() => {
              const pass = photo.pass!
              useGallery.getState().closeLightbox()
              onReplay(pass)
            }}
            aria-label="Replay this pass on the globe"
            className={s.replay}
          >
            <Glyph name="play" size={11} />
            Replay
          </Button>
        ) : null}
      </div>

      {!mobile ? (
        <div ref={setChrome(2)} className={s.film} role="listbox" aria-label="All photos" aria-activedescendant={`lb-thumb-${index}`}>
          <Filmstrip items={items} index={index} onPick={goTo} />
        </div>
      ) : null}
    </div>
  )
}

/** One photo in the viewer: the decoded card image at once, the 2048 px render crossfading in when ready. */
function LbPhoto({ photo, model, hires, reveal }: { photo: Photo; model: ResultsModel; hires: boolean; reveal: boolean }) {
  const base = cardUrl(photo.capture)
  const hi = hiResUrl(photo.capture)
  const [baseOk, setBaseOk] = useState(() => !!decodedPhoto(base))
  const [hiOk, setHiOk] = useState(() => !!(hi && decodedPhoto(hi)))
  const [hiFade, setHiFade] = useState(false)
  useEffect(() => {
    if (baseOk) return
    const ctl = new AbortController()
    loadPhoto(base, ctl.signal)
      .then(() => !ctl.signal.aborted && setBaseOk(true))
      .catch(() => undefined)
    return () => ctl.abort()
  }, [base, baseOk])
  useEffect(() => {
    if (!hires || !hi || hiOk) return
    const ctl = new AbortController()
    loadPhoto(hi, ctl.signal)
      .then(() => {
        if (ctl.signal.aborted) return
        setHiFade(true)
        setHiOk(true)
      })
      .catch(() => undefined)
    return () => ctl.abort()
  }, [hires, hi, hiOk])
  const alt = `${model.meta(photo.pass?.norad ?? photo.capture.norad ?? 0).name} image of ${model.report.place.label}. The place is at the centre.`
  const dim = photo.clouded ? ((photo.capture.cloudCoverPct ?? 0) >= 90 ? s.dimOvercast : s.dimCloud) : undefined
  if (reveal && photo.pass)
    return (
      <PushbroomReveal
        src={base}
        headingDeg={photo.pass.headingDeg}
        lines={cardSpec(photo.capture).px}
        alt={alt}
        startAt="now"
        seenKey={seenKeyOf(photo)}
        className={s.fill}
        frameClassName={cx(s.fillFrame, dim)}
      />
    )
  return (
    <>
      {baseOk ? <img src={base} alt={alt} crossOrigin="anonymous" decoding="async" draggable={false} className={cx(s.img, dim)} /> : <span className={s.acquiring}>Acquiring</span>}
      {hiOk && hi ? <img src={hi} alt="" aria-hidden crossOrigin="anonymous" decoding="async" draggable={false} className={cx(s.img, dim, hiFade && s.hiFade)} /> : null}
    </>
  )
}

function MetaStrip({ photo, model, cover }: { photo: Photo; model: ResultsModel; cover?: 'closest' | 'lastClear' | 'clouded' }) {
  const { capture, pass } = photo
  const meta = model.meta(pass?.norad ?? capture.norad ?? 0)
  const tz = model.tz
  const t = pass ? model.times(pass) : { day: fmtLocalDay(capture.datetime, tz), time: fmtLocalTime(capture.datetime, tz), zone: zoneAbbr(capture.datetime, tz) }
  const lead = cover === 'closest' ? 'Closest look' : cover === 'lastClear' ? 'Last clear look' : cover === 'clouded' ? 'Clouded over' : undefined
  const w = cropWidthKm(capture)
  const status = photo.kind === 'mosaic' ? 'Daily mosaic' : photo.clouded ? `Clouded${capture.cloudCoverPct !== undefined ? ` · ${int(capture.cloudCoverPct)}%` : ''}` : capture.spot === 'clear' ? 'Clear at your spot' : capture.spot === 'cirrus' ? 'Thin cirrus' : undefined
  return (
    <div className={s.metaText}>
      <span className={s.metaRow}>
        <span className={s.metaMain}>
          {lead ? <b className={cx(s.lead, cover === 'clouded' && s.warn)}>{lead} · </b> : null}
          <b>{meta.name}</b> · {t.day} · {t.time} {t.zone}
          <span className={s.dim}>
            {' · '}
            <Ago t={pass?.tClosest ?? capture.datetime} base={model.clock} />
          </span>
        </span>
        {status ? <span className={cx(s.status, photo.clouded && s.warn)}>{status}</span> : null}
      </span>
      <span className={s.metaRow}>
        <span className={s.metaMain}>
          {productLabel(capture)} · {w >= 100 ? int(w) : dec1(w)} km · {coordsOf(model.report.place.lat, model.report.place.lon)}
        </span>
      </span>
      <span className={s.credit}>{credit(capture)}</span>
    </div>
  )
}

function Filmstrip({ items, index, onPick }: { items: Photo[]; index: number; onPick: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current?.children[index] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [index])
  return (
    <div ref={ref} className={s.thumbs}>
      {items.map((p, i) => (
        <button
          key={p.key}
          id={`lb-thumb-${i}`}
          type="button"
          role="option"
          aria-selected={i === index}
          className={cx(s.thumb, i === index && s.thumbOn, p.clouded && s.thumbCloud)}
          onClick={() => onPick(i)}
          aria-label={`Photo ${i + 1}`}
          tabIndex={i === index ? 0 : -1}
        >
          <Thumb url={thumbUrl(p.capture)} near={Math.abs(i - index) <= 12} />
        </button>
      ))}
    </div>
  )
}

/** A filmstrip thumbnail: loads when near the current photo, then stays. */
function Thumb({ url, near }: { url: string; near: boolean }) {
  const [ok, setOk] = useState(() => !!decodedPhoto(url))
  useEffect(() => {
    if (ok || !near) return
    let alive = true
    loadPhoto(url)
      .then(() => alive && setOk(true))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [url, near, ok])
  return ok ? <img src={url} alt="" crossOrigin="anonymous" decoding="async" draggable={false} /> : null
}

function trapFocus(e: KeyboardEvent, root: HTMLElement | null) {
  if (!root) return
  const f = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null)
  if (!f.length) {
    e.preventDefault()
    return
  }
  const first = f[0]
  const last = f[f.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}
