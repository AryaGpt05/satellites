/**
 * Screen-space DOM over the canvas: satellite callouts and the place coordinate label.
 *
 * Scene components project their anchors in useFrame (runtime.anchors); this overlay applies them in the same
 * frame through listeners flushed at FRAME.anchors, writing transforms directly (no React re-render per frame).
 * Content (names, IDs) comes from the store. Kept outside the R3F tree on purpose: drei <Html> re-creates a
 * React root on the same element under StrictMode and can lose its content (React 19).
 * Widths are kept current by ResizeObservers, so the per-frame path only writes styles and never forces a
 * layout.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { selectSelectedPass, useApp } from '@/state/store'
import { fmtLat, fmtLon, fmtNorad, fmtUtcTime } from '@/ui/system/format'
import { getSatInfo, useCatalogBuffers } from './data'
import type { GlobeRuntime } from './runtime'
import s from './GlobeCanvas.module.css'

/** Callout box offset from the point (matches .calloutBox left/right) and the minimum gap to the viewport edge. */
const BOX_OFFSET = 44
const EDGE = 12

export function GlobeOverlay({ runtime }: { runtime: GlobeRuntime }) {
  const place = useApp((st) => st.report?.place ?? st.place)
  const hovered = useApp((st) => st.hoveredNorad)
  const pass = useApp(selectSelectedPass)
  // Names resolve once the catalog is in memory: the app's controller says so via catalogReady, and the globe
  // knows it from its own load (same engine singleton), so callouts never depend on another module's flag.
  const storeCatalogReady = useApp((st) => st.catalogReady)
  const catalogReady = useCatalogBuffers().state === 'ready' || storeCatalogReady
  const imagedHovered = useApp((st) =>
    hovered !== undefined ? !!st.report?.passes.some((p) => p.norad === hovered && p.verdict === 'imaged') : false,
  )

  const root = useRef<HTMLDivElement>(null)
  const vw = useWidthRef(root)

  return (
    <div ref={root} className={s.overlay} aria-hidden>
      {place && <PlaceLabel key={`${place.lat},${place.lon}`} runtime={runtime} vw={vw} lat={place.lat} lon={place.lon} />}
      {hovered !== undefined && hovered !== pass?.norad && (
        <SatLabel
          key={`h${hovered}`}
          runtime={runtime}
          vw={vw}
          id="hover"
          norad={hovered}
          tone={imagedHovered ? 'signal' : 'bone'}
          ready={catalogReady}
        />
      )}
      {pass && (
        <SatLabel
          key={`s${pass.id}`}
          runtime={runtime}
          vw={vw}
          id="selected"
          norad={pass.norad}
          tone={pass.verdict === 'imaged' ? 'signal' : 'bone'}
          detail={pass.verdict === 'imaged' ? `IMAGED ${fmtUtcTime(pass.tClosest)} UTC` : undefined}
          ready={catalogReady}
        />
      )}
    </div>
  )
}

/** Live CSS width of an element, kept in a ref by a ResizeObserver (no layout reads in the frame loop). */
function useWidthRef(ref: RefObject<HTMLElement | null>): RefObject<number> {
  const width = useRef(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      width.current = el.offsetWidth
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

/** Viewport width for placement; falls back to the window before the first measurement. */
const widthOf = (vw: RefObject<number>) => vw.current || window.innerWidth

function useAnchorListener(runtime: GlobeRuntime, fn: () => void) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const l = () => ref.current()
    runtime.anchorListeners.add(l)
    return () => {
      runtime.anchorListeners.delete(l)
    }
  }, [runtime])
}

/** Gap between the reticle centre and the coordinate label (matches .coord left/right). */
const COORD_OFFSET = 36

function PlaceLabel({ runtime, vw, lat, lon }: { runtime: GlobeRuntime; vw: RefObject<number>; lat: number; lon: number }) {
  const el = useRef<HTMLDivElement>(null)
  const label = useRef<HTMLDivElement>(null)
  const labelW = useWidthRef(label)
  const last = useRef({ x: NaN, y: NaN, op: '', flip: false })
  useAnchorListener(runtime, () => {
    const a = runtime.anchors.get('place')
    const d = el.current
    if (!d) return
    const st = last.current
    const op = a?.visible ? '1' : '0'
    if (op !== st.op) {
      st.op = op
      d.style.opacity = op
    }
    if (!a?.visible) return
    const x = Math.round(a.x)
    const y = Math.round(a.y)
    if (x !== st.x || y !== st.y) {
      st.x = x
      st.y = y
      d.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
    // Right of the reticle unless that runs past the viewport edge (phones, a place near the right edge):
    // then it sits to the left, right-aligned, so the coordinates are never clipped.
    const W = widthOf(vw)
    const w = labelW.current
    const flip = x + COORD_OFFSET + w > W - EDGE && x - COORD_OFFSET - w >= EDGE
    if (flip !== st.flip) {
      st.flip = flip
      d.classList.toggle(s.coordFlip, flip)
    }
  })
  return (
    <div ref={el} className={s.anchor} style={{ opacity: 0 }}>
      <div ref={label} className={s.coord}>
        {fmtLat(lat, 4)} {fmtLon(lon, 4)}
      </div>
    </div>
  )
}

function SatLabel({
  runtime,
  vw,
  id,
  norad,
  tone,
  detail,
  ready,
}: {
  runtime: GlobeRuntime
  vw: RefObject<number>
  id: string
  norad: number
  tone: 'signal' | 'bone'
  detail?: string
  ready: boolean
}) {
  const el = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const leader = useRef<SVGPathElement>(null)
  const altEl = useRef<HTMLElement>(null)
  const boxW = useWidthRef(box)
  const last = useRef({ x: NaN, y: NaN, vis: false, flip: false, below: false, shift: 0, altAt: 0 })
  useAnchorListener(runtime, () => {
    const a = runtime.anchors.get(id)
    const d = el.current
    const b = box.current
    if (!d || !b) return
    const st = last.current
    const vis = !!a?.visible
    if (vis !== st.vis) {
      st.vis = vis
      d.style.opacity = vis ? '1' : '0'
    }
    if (!a || !vis) return
    const x = Math.round(a.x)
    const y = Math.round(a.y)
    if (x !== st.x || y !== st.y) {
      st.x = x
      st.y = y
      d.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
    // Box placement: right of the point unless the left has more room; then nudge it inside the viewport
    // and let the leader's level run follow the box's near corner.
    const W = widthOf(vw)
    const w = boxW.current
    const flip = W - x < w + BOX_OFFSET + EDGE && x > W - x
    const near = flip ? x - BOX_OFFSET - w : x + BOX_OFFSET
    let shift = 0
    if (near < EDGE) shift = EDGE - near
    else if (near + w > W - EDGE) shift = W - EDGE - (near + w)
    shift = Math.round(shift)
    const flipChanged = flip !== st.flip
    if (flipChanged) {
      st.flip = flip
      d.classList.toggle(s.calloutFlip, flip)
    }
    if (a.below !== st.below) {
      st.below = a.below
      d.classList.toggle(s.calloutBelow, a.below)
    }
    if (shift !== st.shift || flipChanged) {
      st.shift = shift
      b.style.translate = `${shift}px 0`
      // In the leader's (possibly mirrored) frame, the box corner moves by ±shift.
      const end = Math.max(24.5, BOX_OFFSET + 0.5 + (flip ? -shift : shift))
      leader.current?.setAttribute('d', `M 7.5 -7.5 L 24.5 -24.5 L ${end} -24.5`)
    }
    const now = performance.now()
    if (altEl.current && now - st.altAt > 250) {
      st.altAt = now
      altEl.current.textContent = a.altKm !== null ? Math.round(a.altKm).toLocaleString('en-US') : '—'
    }
  })
  const info = ready ? getSatInfo(norad) : undefined
  const name = info?.displayName ?? info?.name ?? `NORAD ${fmtNorad(norad)}`
  const stroke = tone === 'signal' ? 'var(--signal)' : 'var(--bone-2)'
  return (
    <div ref={el} className={[s.anchor, s.callout, tone === 'signal' ? s.calloutSignal : ''].join(' ')} style={{ opacity: 0 }}>
      <svg className={s.calloutLeader} width="1" height="1" aria-hidden>
        {/* From just outside the glyph, 45° out, then level into the box's corner. Mirrored in CSS. */}
        <path ref={leader} d="M 7.5 -7.5 L 24.5 -24.5 L 44.5 -24.5" stroke={stroke} strokeWidth="1" fill="none" />
      </svg>
      <div ref={box} className={s.calloutBox}>
        <span className={s.calloutName}>{name}</span>
        <span className={s.calloutMeta}>
          NORAD <b>{fmtNorad(norad)}</b> · <b ref={altEl}>—</b> KM
          {detail ? <> · {detail}</> : null}
        </span>
      </div>
    </div>
  )
}
