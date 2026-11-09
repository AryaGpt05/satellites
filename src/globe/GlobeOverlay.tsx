/**
 * Screen-space DOM over the canvas: satellite callouts and the place coordinate label.
 *
 * Scene components project their anchors in useFrame (runtime.anchors); this overlay applies them in the same
 * frame through listeners flushed at FRAME.anchors, writing transforms directly (no React re-render per frame).
 * Content (names, IDs) comes from the store. Kept outside the R3F tree on purpose: drei <Html> re-creates a
 * React root on the same element under StrictMode and can lose its content (React 19).
 *
 * Placement respects the UI that is on screen (store.uiInsets, read with getState in the listener; decision 5):
 *  - horizontally everything stays inside [insets.left + EDGE, W − insets.right − EDGE] (EDGE = bezel + 12);
 *  - a callout box sits above its satellite unless that would reach into the HUD band (insets.top), then below;
 *    if neither fits above the sheet / timeline, the box hides and the glyph stays; it also hides while the
 *    satellite itself is off-screen or under a panel (no box with a leader to nowhere);
 *  - on stacked layouts the callout is one compact line (name · altitude), and hides when the sheet covers
 *    most of the screen; the coordinate label drops below the reticle when neither side fits, with 2 decimals
 *    on narrow phones.
 * Sizes are kept current by ResizeObservers, so the per-frame path only writes styles and never forces a layout.
 * Departing labels stay mounted for 240 ms at opacity 0, so they fade instead of popping (M11).
 *
 * Acquisition sequence (owner request C, rt.acq): at the capture of an imaged pass a mono line snaps in under the
 * coordinates ("ACQUIRED 11:21:13 EST · 10 M"; straight away on a quiet selection), and while a live sequence runs a
 * countdown readout sits top-right under the HUD clock ("T−00:01:12" → "ACQUIRED"), written per frame from the
 * scene clock, never through React.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ensureTz, timeZoneAt, tzReady } from '@/imagery'
import { isStacked } from '@/lib/layout'
import { selectSelectedPass, useApp } from '@/state/store'
// The pure time module only, never the '@/ui/results' index (that is the lazy results chunk).
import { fmtLocalTime, zoneAbbr } from '@/ui/results/lib/time'
import { fmtLat, fmtLon, fmtNorad, fmtUtcTime } from '@/ui/system/format'
import { safeAreaSides } from '@/ui/system/viewport'
import { captureOf, fmtCountdown } from './acquisition'
import { getSatInfo, useCatalogBuffers } from './data'
import { passAnchorId } from './PassOverlay'
import { placeAnchorId } from './PlaceMarker'
import type { GlobeRuntime } from './runtime'
import s from './GlobeCanvas.module.css'

/** Callout box offset from the point (matches .calloutBox left/right and bottom/top). */
const BOX_OFFSET = 44
const BOX_RISE = 24
/** Gap to the bezel: bezel inset + 12 (12 + 10 on stacked layouts, 16 + 12 on desktop). */
const edgeFor = (stacked: boolean) => (stacked ? 22 : 28)
/** The callout keeps its side until the line it crossed is this far behind it (LAP-10). */
const FLIP_HYSTERESIS_PX = 12
/** Departing labels stay mounted this long (the .anchor opacity transition). */
const DEPART_MS = 240
/**
 * A label's visibility must hold this long (ms) before it is applied: a sheet gliding past the satellite, a frame of
 * re-framing or an anchor flickering at a threshold never blinks a label (owner request A1). Leaving is immediate.
 */
const VIS_HOLD_MS = 160

/** Debounced opacity write: returns the opacity in effect. `st` keeps the wanted state and since when. */
function settleOpacity(d: HTMLElement, st: { op: string; want: string; wantAt: number }, want: string, immediate: boolean): string {
  const now = performance.now()
  if (want !== st.want) {
    st.want = want
    st.wantAt = now
  }
  if (want !== st.op && (immediate || st.op === '' || now - st.wantAt >= VIS_HOLD_MS)) {
    st.op = want
    d.style.opacity = want
  }
  return st.op
}

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
  const vp = useSizeRef(root)

  const places = useDeparting(place, (p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`)
  const selectedNorad = pass?.norad
  const hoverItem = useMemo(
    () => (hovered !== undefined && hovered !== selectedNorad ? { norad: hovered, imaged: imagedHovered } : undefined),
    [hovered, selectedNorad, imagedHovered],
  )
  const hovers = useDeparting(hoverItem, (h) => `h${h.norad}`)
  const selected = useDeparting(pass, (p) => p.id)
  const tzLoaded = useTzReady()
  /** "IMAGED 11:21:13 EST": the place's local time, as the pass header says it (UTC until the zone table is in). */
  const imagedAt = (t: number) => {
    if (place && tzLoaded) {
      const tz = timeZoneAt(place.lat, place.lon)
      return `IMAGED ${fmtLocalTime(t, tz, true)} ${zoneAbbr(t, tz)}`
    }
    return `IMAGED ${fmtUtcTime(t)} UTC`
  }

  // The capture line under the coordinates: the image's local time and its ground resolution.
  const report = useApp((st) => st.report)
  const cap = pass && pass.verdict === 'imaged' ? captureOf(report, pass) : undefined
  const acqLine = pass && cap ? `ACQUIRED ${imagedAt(pass.tClosest).replace(/^IMAGED /, '')} · ${Math.round(cap.gsdM)} M` : undefined

  return (
    <div ref={root} className={s.overlay} aria-hidden>
      {pass && <AcqReadout runtime={runtime} vp={vp} passId={pass.id} norad={pass.norad} imaged={!!cap} ready={catalogReady} />}
      {places.map(({ key, item, leaving }) => (
        <PlaceLabel
          key={key}
          runtime={runtime}
          vp={vp}
          id={placeAnchorId(key)}
          lat={item.lat}
          lon={item.lon}
          leaving={leaving}
          acq={acqLine}
          passId={pass?.id}
        />
      ))}
      {hovers.map(({ key, item, leaving }) => (
        <SatLabel
          key={key}
          runtime={runtime}
          vp={vp}
          id="hover"
          norad={item.norad}
          tone={item.imaged ? 'signal' : 'bone'}
          ready={catalogReady}
          leaving={leaving}
        />
      ))}
      {selected.map(({ key, item, leaving }) => (
        <SatLabel
          key={`s${key}`}
          runtime={runtime}
          vp={vp}
          id={passAnchorId(item.id)}
          norad={item.norad}
          tone={item.verdict === 'imaged' ? 'signal' : 'bone'}
          detail={item.verdict === 'imaged' ? imagedAt(item.tClosest) : undefined}
          ready={catalogReady}
          leaving={leaving}
        />
      ))}
    </div>
  )
}

/** True once the time-zone table is in (it normally is long before a pass opens); re-renders when it lands. */
function useTzReady(): boolean {
  const [ready, setReady] = useState(tzReady)
  useEffect(() => {
    if (ready) return
    let alive = true
    void ensureTz().then(() => alive && setReady(tzReady()))
    return () => {
      alive = false
    }
  }, [ready])
  return ready
}

/**
 * The current item plus the ones that just left, flagged `leaving` for DEPART_MS (derived during render, so a
 * new item mounts in the same commit as the change). `cur` must be referentially stable between renders.
 */
function useDeparting<T>(cur: T | undefined, keyOf: (t: T) => string): { key: string; item: T; leaving: boolean }[] {
  const [list, setList] = useState<{ key: string; item: T; leaving: boolean }[]>([])
  const curKey = cur !== undefined ? keyOf(cur) : undefined
  let next = list
  const stale =
    list.some((e) => e.leaving !== (e.key !== curKey) || (e.key === curKey && e.item !== cur)) ||
    (curKey !== undefined && !list.some((e) => e.key === curKey))
  if (stale) {
    next = list.map((e) => (e.key === curKey ? { key: e.key, item: cur as T, leaving: false } : e.leaving ? e : { ...e, leaving: true }))
    if (curKey !== undefined && !next.some((e) => e.key === curKey)) next.push({ key: curKey, item: cur as T, leaving: false })
    setList(next)
  }
  useEffect(() => {
    const leaving = new Set(next.filter((e) => e.leaving).map((e) => e.key))
    if (!leaving.size) return
    const id = window.setTimeout(() => setList((l) => l.filter((e) => !(e.leaving && leaving.has(e.key)))), DEPART_MS)
    return () => window.clearTimeout(id)
  }, [next])
  return next
}

/** Live CSS size of an element, kept in a ref by a ResizeObserver (no layout reads in the frame loop). */
function useSizeRef(ref: RefObject<HTMLElement | null>): RefObject<{ w: number; h: number }> {
  const size = useRef({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      size.current = { w: el.offsetWidth, h: el.offsetHeight }
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

/** Viewport size for placement; falls back to the window before the first measurement. */
const sizeOf = (vp: RefObject<{ w: number; h: number }>) => ({ W: vp.current.w || window.innerWidth, H: vp.current.h || window.innerHeight })

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

/** Gap between the reticle centre and the coordinate label's plate (matches .coord left/right / top). */
const COORD_OFFSET = 30

function PlaceLabel({
  runtime,
  vp,
  id,
  lat,
  lon,
  leaving,
  acq,
  passId,
}: {
  runtime: GlobeRuntime
  vp: RefObject<{ w: number; h: number }>
  id: string
  lat: number
  lon: number
  leaving: boolean
  /** "ACQUIRED 11:21:13 EST · 10 M" for the selected imaged pass */
  acq?: string
  passId?: string
}) {
  const el = useRef<HTMLDivElement>(null)
  const label = useRef<HTMLDivElement>(null)
  const acqEl = useRef<HTMLDivElement>(null)
  const acqShown = useRef(false)
  const labelSize = useSizeRef(label)
  const last = useRef({ x: NaN, y: NaN, op: '', want: '', wantAt: 0, side: '' as '' | 'right' | 'left' | 'below', dx: 0 })
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 400)
  useAnchorListener(runtime, () => {
    const a = runtime.anchors.get(id)
    const d = el.current
    if (!d) return
    const st = last.current
    settleOpacity(d, st, a?.visible && !leaving ? '1' : '0', leaving)
    // The capture line: once the capture has happened (or at once when nothing is live), never during the approach.
    const q = runtime.acq
    const showAcq = !!acq && !!passId && q.passId === passId && q.imaged && !q.armed
    if (showAcq !== acqShown.current && acqEl.current) {
      acqShown.current = showAcq
      acqEl.current.hidden = !showAcq
    }
    const { W, H } = sizeOf(vp)
    const isNarrow = W <= 400
    if (isNarrow !== narrow) setNarrow(isNarrow)
    if (!a?.visible) return
    const x = Math.round(a.x)
    const y = Math.round(a.y)
    if (x !== st.x || y !== st.y) {
      st.x = x
      st.y = y
      d.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
    // Right of the reticle; else left (right-aligned); else centred below it. Bounds are the free columns
    // inside the bezel, so the coordinates are never clipped or under a panel; a side that would touch the
    // selected satellite's callout box is skipped.
    const ins = useApp.getState().uiInsets
    const edge = edgeFor(isStacked(W, H))
    // Clear of a landscape notch and the rounded corners too (PH-04).
    const safe = safeAreaSides()
    const lo = ins.left + edge + safe.left
    const hi = W - ins.right - edge - safe.right
    const { w, h } = labelSize.current
    const cb = runtime.calloutBox
    const clear = (x0: number, y0: number, x1: number, y1: number) =>
      !cb.visible || x1 + 4 < cb.x0 || x0 - 4 > cb.x1 || y1 + 4 < cb.y0 || y0 - 4 > cb.y1
    const top = y - 10
    const side =
      x + COORD_OFFSET + w <= hi && clear(x + COORD_OFFSET, top, x + COORD_OFFSET + w, top + h)
        ? 'right'
        : x - COORD_OFFSET - w >= lo && clear(x - COORD_OFFSET - w, top, x - COORD_OFFSET, top + h)
          ? 'left'
          : 'below'
    if (side !== st.side) {
      st.side = side
      d.classList.toggle(s.coordFlip, side === 'left')
      d.classList.toggle(s.coordBelow, side === 'below')
    }
    // Centred below the reticle, but never past the free columns (INT-06: in a narrow band it crossed the bezel).
    const dx = side === 'below' && w > 0 ? Math.round(Math.min(Math.max(x, lo + w / 2), Math.max(lo + w / 2, hi - w / 2)) - x) : 0
    if (dx !== st.dx && label.current) {
      st.dx = dx
      label.current.style.setProperty('--below-dx', `${dx}px`)
    }
  })
  const digits = narrow ? 2 : 4
  return (
    <div ref={el} className={[s.anchor, leaving ? s.leaving : ''].join(' ')} style={{ opacity: 0 }}>
      <div ref={label} className={s.coord}>
        {fmtLat(lat, digits)} {fmtLon(lon, digits)}
        <div ref={acqEl} className={s.coordAcq} hidden>
          {acq}
        </div>
      </div>
    </div>
  )
}

function SatLabel({
  runtime,
  vp,
  id,
  norad,
  tone,
  detail,
  ready,
  leaving,
}: {
  runtime: GlobeRuntime
  vp: RefObject<{ w: number; h: number }>
  id: string
  norad: number
  tone: 'signal' | 'bone'
  detail?: string
  ready: boolean
  leaving: boolean
}) {
  const el = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const leader = useRef<SVGPathElement>(null)
  const altEl = useRef<HTMLElement>(null)
  const boxSize = useSizeRef(box)
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && isStacked(window.innerWidth, window.innerHeight))
  const last = useRef({ x: NaN, y: NaN, op: '', want: '', wantAt: 0, flip: false, below: false, shift: 0, altAt: 0 })
  useAnchorListener(runtime, () => {
    const a = runtime.anchors.get(id)
    const d = el.current
    const b = box.current
    if (!d || !b) return
    const st = last.current
    const { W, H } = sizeOf(vp)
    const stacked = isStacked(W, H)
    if (stacked !== compact) setCompact(stacked)
    const ins = useApp.getState().uiInsets
    const edge = edgeFor(stacked)

    let show = !!a?.visible && !leaving
    // Stacked: when the sheet covers most of the screen the callout would only crowd the sliver of globe left.
    if (stacked && ins.bottom > 0.7 * H) show = false
    // The satellite itself must be on screen and not under a panel, the HUD band or the acquisition countdown: a box
    // nudged into the free columns with a leader running off-screen (or under the dock, or into the readouts) reads as
    // detached, mid-flight and as the acquisition's dive drops the spacecraft out of the top of the frame especially.
    const topEdge = Math.max(ins.top, runtime.readoutBottom) + 4
    if (a && (a.x < ins.left - 2 || a.x > W - ins.right + 2 || a.y < topEdge || a.y > H - ins.bottom + 2)) show = false
    let below = st.below
    if (a && show) {
      const x = Math.round(a.x)
      const y = Math.round(a.y)
      if (x !== st.x || y !== st.y) {
        st.x = x
        st.y = y
        d.style.transform = `translate3d(${x}px, ${y}px, 0)`
      }
      const { w, h } = boxSize.current
      // Above the point unless that reaches into the HUD band (or the acquisition countdown under it); then below, if
      // that clears the sheet / timeline.
      // With a little hysteresis, so a camera settling near the line never flips it back and forth (LAP-10).
      const band = Math.max(ins.top, runtime.readoutBottom)
      below = y - BOX_RISE - h < band + (st.below ? FLIP_HYSTERESIS_PX : 0)
      if (below && y + BOX_RISE + h > H - ins.bottom - 8) show = false
      // Right of the point unless the left has more room; then nudge it inside the free columns and let the
      // leader's level run follow the box's near corner.
      const lo = ins.left + edge
      const hi = W - ins.right - edge
      const flip = x + BOX_OFFSET + w > hi && x - lo > hi - x
      const near = flip ? x - BOX_OFFSET - w : x + BOX_OFFSET
      let shift = 0
      if (near < lo) shift = lo - near
      else if (near + w > hi) shift = hi - (near + w)
      shift = Math.round(shift)
      const flipChanged = flip !== st.flip
      if (flipChanged) {
        st.flip = flip
        d.classList.toggle(s.calloutFlip, flip)
      }
      if (below !== st.below) {
        st.below = below
        d.classList.toggle(s.calloutBelow, below)
        // The box glides to its new side (240 ms, transform only) instead of jumping 2 × BOX_RISE + its height (LAP-10).
        if (st.op === '1' && !runtime.reducedMotion && typeof b.animate === 'function') {
          const from = (2 * BOX_RISE + h) * (below ? -1 : 1)
          b.animate([{ transform: `translateY(${from}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,0,0,1)' })
          leader.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'linear' })
        }
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
    }
    const shown = settleOpacity(d, st, show ? '1' : '0', leaving) === '1'
    // Publish where the selected callout's box sits, so the coordinate label can keep clear of it.
    if (id !== 'hover') {
      const { w, h } = boxSize.current
      const cb = runtime.calloutBox
      cb.visible = shown && !leaving
      if (cb.visible) {
        cb.x0 = (st.flip ? st.x - BOX_OFFSET - w : st.x + BOX_OFFSET) + st.shift
        cb.x1 = cb.x0 + w
        cb.y0 = st.below ? st.y + BOX_RISE : st.y - BOX_RISE - h
        cb.y1 = cb.y0 + h
      }
    }
  })
  // A selected callout that unmounts must not leave its box behind for the coordinate label.
  useEffect(
    () => () => {
      if (id !== 'hover') runtime.calloutBox.visible = false
    },
    [id, runtime],
  )
  const info = ready ? getSatInfo(norad) : undefined
  const name = info?.displayName ?? info?.name ?? `NORAD ${fmtNorad(norad)}`
  const stroke = tone === 'signal' ? 'var(--signal)' : 'var(--bone-2)'
  return (
    <div
      ref={el}
      className={[s.anchor, s.callout, tone === 'signal' ? s.calloutSignal : '', compact ? s.calloutCompact : '', leaving ? s.leaving : ''].join(' ')}
      style={{ opacity: 0 }}
    >
      <svg className={s.calloutLeader} width="1" height="1" aria-hidden>
        {/* From just outside the glyph, 45° out, then level into the box's corner. Mirrored in CSS. */}
        <path ref={leader} d="M 7.5 -7.5 L 24.5 -24.5 L 44.5 -24.5" stroke={stroke} strokeWidth="1" fill="none" />
      </svg>
      <div ref={box} className={s.calloutBox}>
        <span className={s.calloutName}>{name}</span>
        {compact ? (
          <span className={s.calloutMeta}>
            {'· '}
            <b ref={altEl}>—</b> KM
          </span>
        ) : (
          <span className={s.calloutMeta}>
            NORAD <b>{fmtNorad(norad)}</b> · <b ref={altEl}>—</b> KM
            {detail ? <> · {detail}</> : null}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The acquisition countdown, top-right under the HUD clock band (the top-right corner of the free area: the HUD's scrim
 * would dim it inside the band), right-aligned: "ACQUISITION · SENTINEL-2C" over
 * "T−00:01:12", snapping to "ACQUIRED" at the capture; for passes without an image "CLOSEST APPROACH". Visible while
 * a live sequence runs and for a moment after its capture. Written every frame from the runtime (text only when it
 * changes), never through React state. While it shows, callouts keep below it.
 */
const READOUT_HOLD_MS = 2600
/** The readout's height before its first measurement (desktop type scale; phones measure taller). */
const READOUT_H = 34

function AcqReadout({
  runtime,
  vp,
  passId,
  norad,
  imaged,
  ready,
}: {
  runtime: GlobeRuntime
  vp: RefObject<{ w: number; h: number }>
  passId: string
  norad: number
  imaged: boolean
  ready: boolean
}) {
  const el = useRef<HTMLDivElement>(null)
  const value = useRef<HTMLDivElement>(null)
  const last = useRef({ op: '', text: '', done: false, x: NaN, y: NaN })
  // Its real height (the type scale differs on phones), measured off the frame loop: callouts and the chase's framing
  // keep below its bottom edge.
  const height = useRef(READOUT_H)
  useEffect(() => {
    const d = el.current
    if (!d || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      height.current = d.offsetHeight || READOUT_H
    })
    ro.observe(d)
    return () => ro.disconnect()
  }, [])
  useEffect(
    () => () => {
      runtime.readoutBottom = 0
    },
    [runtime],
  )
  useAnchorListener(runtime, () => {
    const d = el.current
    const v = value.current
    if (!d || !v) return
    const q = runtime.acq
    const st = last.current
    const mine = q.passId === passId
    const captured = mine && q.capturedAt > q.armedAt && q.armedAt > -Infinity
    const show = mine && (q.armed || (captured && performance.now() - q.capturedAt < READOUT_HOLD_MS))
    const op = show ? '1' : '0'
    if (op !== st.op) {
      st.op = op
      d.style.opacity = op
    }
    const ins = useApp.getState().uiInsets
    const { W, H } = sizeOf(vp)
    const stacked = isStacked(W, H)
    runtime.readoutBottom = show ? ins.top + 8 + height.current : 0
    if (!show) return
    const text = captured ? (imaged ? 'ACQUIRED' : 'CLOSEST APPROACH') : fmtCountdown(runtime.simTime, q.tc)
    if (text !== st.text) {
      st.text = text
      v.textContent = text
    }
    if (captured !== st.done) {
      st.done = captured
      d.classList.toggle(s.acqDone, captured)
    }
    const x = Math.round(ins.right + edgeFor(stacked))
    const y = Math.round(ins.top + 8)
    if (x !== st.x || y !== st.y) {
      st.x = x
      st.y = y
      d.style.transform = `translate3d(${-x}px, ${y}px, 0)`
    }
  })
  const info = ready ? getSatInfo(norad) : undefined
  const name = info?.displayName ?? info?.name ?? `NORAD ${fmtNorad(norad)}`
  return (
    <div ref={el} className={s.acqReadout} style={{ opacity: 0 }}>
      <div className={s.acqLabel}>
        {imaged ? 'ACQUISITION' : 'CLOSEST APPROACH'} · {name}
      </div>
      <div ref={value} className={s.acqValue}>
        T{'\u2212'}00:00:00
      </div>
    </div>
  )
}
