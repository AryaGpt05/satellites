/**
 * Sheet: the one panel container (DESIGN §4, §8).
 *
 *  - Wide (see src/lib/layout.ts): docked right inside the bezel, 432px wide (`--panel-w`), clear of
 *    the corner readouts above and below. Flat ink, hairline border, no radius, no shadow.
 *  - Stacked (phones, portrait tablets): a bottom sheet with snap points that behaves like a native one:
 *      · a swipe anywhere on it moves it (below the top snap the body does not scroll: it is the handle);
 *      · at the top snap the body scrolls, and pulling down at scrollTop 0 hands over to the sheet;
 *      · a release settles at a speed that follows the flick (200–440 ms, --ease-out, no overshoot);
 *      · a tap on the header at the lowest snap raises it one snap; the grip is also a button
 *        (tap / Enter cycles, ↑/↓ step), so it works without a pointer.
 *
 * Layout inside: [grip (stacked)] → header (fixed) → body (scrolls) → footer (fixed).
 *
 * The header never moves the body in layout (R3-9: no layout shift when it grows or shrinks): the header
 * (with the grip on phones) overlays the top of the sheet, and the body is laid out from the sheet's top,
 * drawn below the header with a transform and shortened by the same amount, written in the frame the
 * header's height changes. So a header that changes height costs a transform (compositor), never a
 * shift of the content under it. For callers that measure, `bodyEl.offsetTop` still reports where the
 * body starts (the header's height), as it did when the header was in flow.
 *
 * Usage:
 *   <Sheet label="Passes" header={<h2>…</h2>} snaps={[0.3, 0.62, 0.92]} defaultSnap={1}>
 *     …long content…
 *   </Sheet>
 *
 * Controlled snapping: pass `snap` + `onSnapChange`. Snaps may be measured px and may change at runtime:
 * the sheet glides from where it is to the new position. `onVisibleChange(px, settled)` reports the
 * visible height (px from the bottom of the viewport, safe area included) every frame while it is
 * dragged or settling, then once with `settled` when it comes to rest. `onClose` adds a close button
 * (and, with `dismissible`, lets a drag below the lowest snap close it). Esc handling is left to the app
 * unless `closeOnEscape` is set. The element exposes `--sheet-visible` / `--sheet-hidden` (px),
 * `data-snap` and `data-at-max` for children and tests. Mark anything inside that handles its own
 * vertical drags with `data-sheet-nodrag`.
 *
 * Position is written imperatively (transform + transition on the section, and the opposite transform
 * on the footer, so both moves stay on the compositor and never lay out);
 * React only renders the height and the snap variables.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react'
import { easeOut } from '@/lib/ease'
import { Glyph } from './Glyph'
import { useIsMobile } from './media'
import { prefersReducedMotion } from './motion'
import { cx } from './primitives'
import { clampIndex, resolveSnap, rubberband, settleMs, snapHeightsPx, topOvershoot } from './sheetMath'
import s from './Sheet.module.css'

export interface SheetProps {
  /** Accessible name of the region */
  label: string
  children: ReactNode
  /** Fixed above the scrolling body; on mobile it is also a drag surface and shows at the lowest snap */
  header?: ReactNode
  /** Fixed below the scrolling body (actions) */
  footer?: ReactNode
  /** Mobile snap points (visible heights), any order: ≤ 1 = fraction of viewport height, > 1 = px */
  snaps?: number[]
  /** Controlled snap index (into the ascending snap list) */
  snap?: number
  /** Initial snap index when uncontrolled. Default: the middle snap */
  defaultSnap?: number
  onSnapChange?: (index: number) => void
  /**
   * Stacked only: the visible height in px (safe area included), every frame while dragged or settling
   * (`settled` false), then once when it comes to rest (`settled` true).
   */
  onVisibleChange?: (px: number, settled: boolean) => void
  /** Adds a close button; called on press (and on dismiss-drag / Esc when enabled) */
  onClose?: () => void
  closeLabel?: string
  /** Mobile: dragging well below the lowest snap calls onClose */
  dismissible?: boolean
  closeOnEscape?: boolean
  className?: string
  bodyClassName?: string
  bodyRef?: Ref<HTMLDivElement>
}

const DEFAULT_SNAPS = [0.3, 0.6, 0.92]
/**
 * Mobile: the tallest snap stops this far below the top of the viewport, so the two lines of the top
 * corner readouts (bezel inset 10 + 12 + 2 × 15 + 3) and a breath of space stay visible above it.
 */
const TOP_CLEAR_PX = 64
/** A drag past the top snap never lifts the sheet higher than this (the HUD band stays clear). */
const TOP_CEILING_PX = TOP_CLEAR_PX - 8
/** Movement before a press becomes a drag (so buttons inside still click). */
const DRAG_SLOP_PX = 5
/** At the top snap, a pull this far down at scrollTop 0 hands the gesture from the body to the sheet. */
const HANDOFF_PX = 6
const DISMISS_PX = 72
/** Elements a drag never starts from: they handle their own pointer input (a search's suggestion list scrolls). */
const NO_DRAG = '[data-sheet-nodrag], [data-suggestions], input, textarea, select, [contenteditable="true"]'
/** A tap on these is theirs, not a request to raise the sheet. */
const INTERACTIVE = 'button, a[href], input, select, textarea, label, summary, [role="button"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])'

interface Settle {
  from: number
  to: number
  t0: number
  ms: number
}

export function Sheet({
  label,
  children,
  header,
  footer,
  snaps = DEFAULT_SNAPS,
  snap,
  defaultSnap,
  onSnapChange,
  onVisibleChange,
  onClose,
  closeLabel = 'Close',
  dismissible = false,
  closeOnEscape = false,
  className,
  bodyClassName,
  bodyRef,
}: SheetProps) {
  const mobile = useIsMobile()
  const rootRef = useRef<HTMLElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  const bodyEl = useRef<HTMLDivElement | null>(null)
  const setBodyRef = useCallback(
    (el: HTMLDivElement | null) => {
      bodyEl.current = el
      if (typeof bodyRef === 'function') bodyRef(el)
      else if (bodyRef) (bodyRef as { current: HTMLDivElement | null }).current = el
    },
    [bodyRef],
  )
  const vh = useViewportHeight()
  const snapKey = snaps.join(',')
  // Leave room above the tallest snap for the top corner readouts.
  // `snapKey` stands in for `snaps`, which callers often pass as a fresh inline array.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const heights = useMemo(() => snapHeightsPx(snaps, vh, vh - TOP_CLEAR_PX), [snapKey, vh])
  const max = heights[heights.length - 1]

  const [own, setOwn] = useState(() => defaultSnap ?? Math.floor((snaps.length - 1) / 2))
  const index = clampIndex(snap ?? own, heights.length)
  const visible = heights[index]
  const atMax = index >= heights.length - 1
  const setIndex = useCallback(
    (i: number) => {
      const next = clampIndex(i, heights.length)
      if (snap === undefined) setOwn(next)
      onSnapChange?.(next)
    },
    [heights.length, snap, onSnapChange],
  )

  // Latest values for handlers that outlive a render (window listeners, rAF loops).
  const live = useRef({ heights, max, index, vh, atMax, dismissible, onClose, setIndex, onVisibleChange })
  live.current = { heights, max, index, vh, atMax, dismissible, onClose, setIndex, onVisibleChange }

  const drag = useRef<{ active: boolean; detach: () => void } | null>(null)
  /** Set by the body's touch listener when a pull-down at the top of the scroll belongs to the sheet. */
  const handoff = useRef(false)
  const suppressClick = useRef(false)
  const [dragging, setDragging] = useState(false)

  // ── imperative position ────────────────────────────────────────────────────────────────
  /** Where the sheet is (translateY px); `settle` is the transition in flight, if any. */
  const pos = useRef<{ max: number; offset: number; settle: Settle | null } | null>(null)
  const emitRaf = useRef(0)
  const settleRaf = useRef(0)

  /** The translateY on screen right now (mid-transition included), without reading style. */
  const currentOffset = (now = performance.now()): number => {
    const p = pos.current
    if (!p) return 0
    const st = p.settle
    if (!st) return p.offset
    const k = Math.min(1, (now - st.t0) / st.ms)
    return st.from + (st.to - st.from) * easeOut(k)
  }

  const emit = (px: number, settled: boolean) => {
    const cb = live.current.onVisibleChange
    if (!cb) return
    if (settled) {
      cancelAnimationFrame(emitRaf.current)
      emitRaf.current = 0
      cb(px, true)
      return
    }
    if (emitRaf.current) return
    emitRaf.current = requestAnimationFrame(() => {
      emitRaf.current = 0
      cb(live.current.max - currentOffset(), false)
    })
  }

  /** Jump (no transition) to `offset`. */
  const jump = (offset: number) => {
    const el = rootRef.current
    if (!el) return
    cancelAnimationFrame(settleRaf.current)
    el.style.transition = 'none'
    el.style.transform = `translate3d(0, ${offset}px, 0)`
    const foot = footRef.current
    if (foot) {
      foot.style.transition = 'none'
      foot.style.transform = `translate3d(0, ${-offset}px, 0)`
    }
    pos.current = { max: live.current.max, offset, settle: null }
  }

  /** Glide to `offset` over `ms` on --ease-out; report the visible height every frame until it lands. */
  const settleTo = (offset: number, ms: number) => {
    const el = rootRef.current
    if (!el) return
    const from = currentOffset()
    const dur = prefersReducedMotion() ? Math.min(ms, 160) : ms
    el.style.transition = `transform ${dur}ms var(--ease-out)`
    el.style.transform = `translate3d(0, ${offset}px, 0)`
    const foot = footRef.current
    if (foot) {
      // The same curve and start as the sheet's: the two composited moves cancel, the footer holds still.
      foot.style.transition = `transform ${dur}ms var(--ease-out)`
      foot.style.transform = `translate3d(0, ${-offset}px, 0)`
    }
    const settle: Settle = { from, to: offset, t0: performance.now(), ms: Math.max(1, dur) }
    pos.current = { max: live.current.max, offset, settle }
    cancelAnimationFrame(settleRaf.current)
    const frame = (now: number) => {
      const p = pos.current
      if (!p || p.settle !== settle) return
      if (now - settle.t0 >= settle.ms) {
        p.settle = null
        settleRaf.current = 0
        emit(live.current.max - offset, true)
        return
      }
      live.current.onVisibleChange?.(live.current.max - currentOffset(now), false)
      settleRaf.current = requestAnimationFrame(frame)
    }
    settleRaf.current = requestAnimationFrame(frame)
  }

  // Keep the sheet where its snap says (snap / snap-list / viewport changes), gliding from where it is.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    if (!mobile) {
      cancelAnimationFrame(settleRaf.current)
      el.style.transform = ''
      el.style.transition = ''
      if (footRef.current) {
        footRef.current.style.transform = ''
        footRef.current.style.transition = ''
      }
      pos.current = null
      return
    }
    if (drag.current?.active) return
    const target = max - visible
    const p = pos.current
    if (!p) {
      // First placement: no transition (the sheet's own entrance animates it in).
      jump(target)
      emit(visible, true)
      return
    }
    let from = currentOffset()
    const resized = p.max !== max
    if (resized) {
      // The snap list (and so the sheet's height) changed: hold the visible top where it was, commit
      // that, then glide. One style read, only when the snap list changes.
      from = max - (p.max - from)
      jump(from)
      void getComputedStyle(el).transform
    }
    const inFlight = pos.current?.settle
    if (inFlight && Math.abs(inFlight.to - target) < 0.5) return
    if (!inFlight && Math.abs(target - from) < 0.5) {
      if (resized) emit(visible, true)
      return
    }
    settleTo(target, settleMs(target - from))
  }, [mobile, max, visible])

  // Below the top snap the body is a handle, not a scroller: settle it back to its top.
  const prevIndex = useRef(index)
  useLayoutEffect(() => {
    const was = prevIndex.current
    prevIndex.current = index
    const body = bodyEl.current
    if (!mobile || !body || atMax || was === index || body.scrollTop <= 0) return
    body.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [index, atMax, mobile])

  useEffect(
    () => () => {
      cancelAnimationFrame(settleRaf.current)
      cancelAnimationFrame(emitRaf.current)
      // Reset, or a remount that keeps the refs (StrictMode) would think an emit is still queued.
      settleRaf.current = 0
      emitRaf.current = 0
    },
    [],
  )

  // ── drag (stacked only) ────────────────────────────────────────────────────────────────
  // The gesture is tracked with window listeners from pointerdown on, so a fast first move that leaves
  // the sheet still counts, and no pointer capture steals clicks from buttons inside.

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!mobile || drag.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    const target = e.target as Element
    if (target.closest?.(NO_DRAG)) return
    const body = bodyEl.current
    // At the top snap the body scrolls natively; only a pull-down from scrollTop 0 moves the sheet.
    const bodyMode = !!body && body.contains(target) && live.current.atMax
    const id = e.pointerId
    const x0 = e.clientX
    const y0 = e.clientY
    let yA = y0
    let offset0 = 0
    const samples = [{ t: e.timeStamp, y: e.clientY }]
    const state = { active: false, detach: () => undefined as void }

    const activate = (ev: PointerEvent) => {
      state.active = true
      yA = ev.clientY
      offset0 = currentOffset()
      jump(offset0)
      setDragging(true)
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      const dy = ev.clientY - y0
      const dx = ev.clientX - x0
      if (!state.active) {
        if (bodyMode) {
          const ready = ev.pointerType === 'touch' ? handoff.current : dy > HANDOFF_PX && (body?.scrollTop ?? 0) <= 0
          if (!ready) {
            // A mouse drag that goes up or sideways is a scroll / text selection, not ours.
            if (ev.pointerType !== 'touch' && Math.max(Math.abs(dx), -dy) > DRAG_SLOP_PX) state.detach()
            return
          }
        } else {
          if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_SLOP_PX) return
          // Sideways first: a horizontal scroller or scrubber inside, not the sheet.
          if (Math.abs(dx) > Math.abs(dy)) {
            state.detach()
            drag.current = null
            return
          }
        }
        activate(ev)
      }
      ev.preventDefault()
      const { heights: hs, max: mx, vh: h, dismissible: dis } = live.current
      const lowest = mx - hs[0]
      let off = offset0 + (ev.clientY - yA)
      if (off < 0) off = topOvershoot(off, h - mx, TOP_CEILING_PX, 32)
      else if (off > lowest) off = lowest + (dis ? off - lowest : rubberband(off - lowest, 60))
      jump(off)
      emit(mx - off, false)
      samples.push({ t: ev.timeStamp, y: ev.clientY })
      if (samples.length > 6) samples.shift()
    }
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      state.detach()
      drag.current = null
      handoff.current = false
      if (!state.active) return
      // The click that follows this pointerup (if it lands on a button) must not fire.
      suppressClick.current = true
      window.setTimeout(() => (suppressClick.current = false), 0)
      setDragging(false)
      const { heights: hs, max: mx, index: idx, dismissible: dis, onClose: close, setIndex: set } = live.current
      const released = currentOffset()
      if (ev.type === 'pointercancel') {
        settleTo(mx - hs[idx], settleMs(mx - hs[idx] - released, 0))
        return
      }
      const first = samples[0]
      const last = samples[samples.length - 1]
      const velocity = -(last.y - first.y) / Math.max(1, last.t - first.t) // px/ms, + = growing
      const releasedVisible = mx - released
      if (dis && close && releasedVisible < hs[0] - DISMISS_PX) {
        close()
        return
      }
      const next = resolveSnap(hs, releasedVisible, velocity)
      const to = mx - hs[next]
      settleTo(to, settleMs(to - released, velocity))
      if (next !== idx) set(next)
    }
    state.detach = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    drag.current = state
  }
  useEffect(() => () => drag.current?.detach(), [])

  // Touch at the top snap: the body scrolls natively (touch-action: pan-y) unless the first move is a
  // pull-down from scrollTop 0, which is cancelled here so the pointer drag above can take it.
  useEffect(() => {
    const body = bodyEl.current
    if (!mobile || !body) return
    let y0 = 0
    let decided = false
    const start = (e: TouchEvent) => {
      decided = e.touches.length !== 1
      handoff.current = false
      if (!decided) y0 = e.touches[0].clientY
    }
    const move = (e: TouchEvent) => {
      if (!live.current.atMax) return
      if (!decided) {
        const dy = e.touches[0].clientY - y0
        if (Math.abs(dy) <= HANDOFF_PX) return
        decided = true
        handoff.current = dy > 0 && body.scrollTop <= 0
      }
      if (handoff.current && e.cancelable) e.preventDefault()
    }
    body.addEventListener('touchstart', start, { passive: true })
    body.addEventListener('touchmove', move, { passive: false })
    return () => {
      body.removeEventListener('touchstart', start)
      body.removeEventListener('touchmove', move)
    }
  }, [mobile])

  const onGripKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex(index + 1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex(index - 1)
    }
  }
  const cycle = () => setIndex(index >= heights.length - 1 ? 0 : index + 1)
  // A tap on the header at the lowest snap (not on one of its controls) raises the sheet one snap.
  const onHeadClick = (e: React.MouseEvent) => {
    if (index !== 0 || heights.length < 2) return
    if ((e.target as Element).closest?.(INTERACTIVE)) return
    setIndex(1)
  }

  useEffect(() => {
    if (!closeOnEscape || !onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && rootRef.current?.contains(document.activeElement)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeOnEscape, onClose])

  // Mobile: the footer rides at the bottom of the *visible* part, so the body needs its height as padding.
  // Written in the next frame, before its layout (R3-12): a size write inside an observer's delivery would
  // resize the body under any observer of it and end the frame on a ResizeObserver loop error.
  useEffect(() => {
    const foot = footRef.current
    const root = rootRef.current
    if (!foot || !root || typeof ResizeObserver === 'undefined') return
    let raf = 0
    let px = -1
    const ro = new ResizeObserver((entries) => {
      const h = Math.round(entries[0]?.borderBoxSize?.[0]?.blockSize ?? foot.offsetHeight)
      if (h === px) return
      px = h
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          root.style.setProperty('--sheet-foot', `${px}px`)
        })
    })
    ro.observe(foot)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [footer != null])

  useHeadOffset(headRef, bodyEl, mobile, mobile || header != null || onClose != null)

  const sheetProps = mobile
    ? {
        onPointerDown,
        onClickCapture: (e: React.MouseEvent) => {
          if (suppressClick.current) {
            suppressClick.current = false
            e.preventDefault()
            e.stopPropagation()
          }
        },
      }
    : {}

  const style = mobile
    ? ({
        height: `${max}px`,
        '--sheet-visible': `${visible}px`,
        '--sheet-hidden': `${max - visible}px`,
      } as React.CSSProperties)
    : undefined

  return (
    <section
      ref={rootRef}
      className={cx(s.sheet, mobile ? s.bottom : s.dock, dragging && s.dragging, className)}
      aria-label={label}
      data-snap={mobile ? index : undefined}
      data-at-max={mobile ? String(atMax) : undefined}
      style={style}
      {...sheetProps}
    >
      {mobile ? (
        <div ref={headRef} className={cx(s.top, s.dragZone)} onClick={onHeadClick}>
          <button
            type="button"
            className={s.grip}
            onClick={cycle}
            onKeyDown={onGripKey}
            aria-label={index >= heights.length - 1 ? 'Collapse panel' : 'Expand panel'}
          >
            <span className={s.gripMark} aria-hidden />
          </button>
          {header || onClose ? (
            <div className={s.head}>
              <div className={s.headMain}>{header}</div>
              {onClose ? <CloseButton label={closeLabel} onClose={onClose} /> : null}
            </div>
          ) : null}
        </div>
      ) : header || onClose ? (
        <div ref={headRef} className={cx(s.top, s.head)}>
          <div className={s.headMain}>{header}</div>
          {onClose ? <CloseButton label={closeLabel} onClose={onClose} /> : null}
        </div>
      ) : null}
      <div ref={setBodyRef} className={cx(s.body, bodyClassName)}>
        {children}
      </div>
      {footer ? (
        <div ref={footRef} className={s.foot}>
          {footer}
        </div>
      ) : null}
    </section>
  )
}

function CloseButton({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <button type="button" className={s.close} onClick={onClose} aria-label={label} title={label}>
      <Glyph name="close" size={14} />
    </button>
  )
}

/**
 * The body below an overlaid header (R3-9). The body is laid out from the sheet's top, so the header's
 * height never moves it in layout; it is drawn below the header with `translateY(header)` and shortened by
 * the same `margin-bottom`, so it ends where it did (above the footer). Both are measured once when the
 * header mounts (the first frame is placed); after that the header's ResizeObserver writes the transform
 * in the frame the height changed (paint only, before that frame is painted) and the margin in the next
 * frame, before its layout, so no observer of the body sees it resized inside its own delivery.
 * `body.offsetTop` reports the header's height, where the body starts, as it did with the header in flow.
 */
function useHeadOffset(headRef: RefObject<HTMLDivElement | null>, bodyRef: RefObject<HTMLDivElement | null>, mobile: boolean, present: boolean) {
  useLayoutEffect(() => {
    const head = headRef.current
    const body = bodyRef.current
    if (!head || !body || !present) return
    const dpr = window.devicePixelRatio || 1
    const measure = () => Math.round(head.getBoundingClientRect().height * dpr) / dpr
    const place = (px: number) => void (body.style.transform = px ? `translateY(${px}px)` : '')
    const size = (px: number) => void (body.style.marginBottom = px ? `${px}px` : '')
    let h = measure()
    place(h)
    size(h)
    Object.defineProperty(body, 'offsetTop', { configurable: true, get: () => head.offsetHeight })
    let raf = 0
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            // Read live, not from the entry: an earlier observer in this delivery may have changed it again.
            const next = measure()
            if (Math.abs(next - h) < 0.01) return
            h = next
            place(h)
            if (!raf)
              raf = requestAnimationFrame(() => {
                raf = 0
                size(h)
              })
          })
    ro?.observe(head)
    return () => {
      ro?.disconnect()
      cancelAnimationFrame(raf)
      delete (body as { offsetTop?: number }).offsetTop
      place(0)
      size(0)
    }
  }, [headRef, bodyRef, mobile, present])
}

/** window.innerHeight, live (address-bar collapse on mobile changes it). */
function useViewportHeight(): number {
  const [h, setH] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight))
  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setH(window.innerHeight))
    }
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [])
  return h
}
