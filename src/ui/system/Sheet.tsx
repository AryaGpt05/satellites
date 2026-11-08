/**
 * Sheet: the one panel container (DESIGN §4, §8).
 *
 *  - Desktop (> 760px): docked right inside the bezel, 432px wide (`--panel-w`), clear of the corner
 *    readouts above and below. Flat ink, hairline border, no radius, no shadow.
 *  - Mobile (≤ 760px): a bottom sheet with snap points. Drag the grip or the header to resize; a
 *    fast flick moves one snap in that direction. The grip is also a button (tap / Enter cycles,
 *    ↑/↓ step) so it works without a pointer.
 *
 * Layout inside: [grip (mobile)] → header (fixed) → body (scrolls) → footer (fixed).
 * At lower snaps the body is padded so its end can still be scrolled into the visible part.
 *
 * Usage:
 *   <Sheet label="Passes" header={<h2>…</h2>} snaps={[0.3, 0.62, 0.92]} defaultSnap={1}>
 *     …long content…
 *   </Sheet>
 *
 * Controlled snapping: pass `snap` + `onSnapChange`. `onClose` adds a close button (and, with
 * `dismissible`, lets a mobile drag below the lowest snap close it). Esc handling is left to the app
 * unless `closeOnEscape` is set. The sheet element exposes `--sheet-visible` (px, mobile) and
 * `data-snap` for children and tests.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { Glyph } from './Glyph'
import { useIsMobile } from './media'
import { cx } from './primitives'
import { clampIndex, resolveSnap, rubberband, snapHeightsPx } from './sheetMath'
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
/** Movement before a press on the header becomes a drag (so header buttons still click). */
const DRAG_SLOP_PX = 5
const DISMISS_PX = 72

export function Sheet({
  label,
  children,
  header,
  footer,
  snaps = DEFAULT_SNAPS,
  snap,
  defaultSnap,
  onSnapChange,
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
  const vh = useViewportHeight()
  const snapKey = snaps.join(',')
  // Leave room above the tallest snap for the top corner readouts.
  // `snapKey` stands in for `snaps`, which callers often pass as a fresh inline array.
  const heights = useMemo(() => snapHeightsPx(snaps, vh, vh - TOP_CLEAR_PX), [snapKey, vh])
  const max = heights[heights.length - 1]

  const [own, setOwn] = useState(() => defaultSnap ?? Math.floor((snaps.length - 1) / 2))
  const index = clampIndex(snap ?? own, heights.length)
  const visible = heights[index]
  const setIndex = useCallback(
    (i: number) => {
      const next = clampIndex(i, heights.length)
      if (snap === undefined) setOwn(next)
      onSnapChange?.(next)
    },
    [heights.length, snap, onSnapChange],
  )

  // ── drag (mobile only) ─────────────────────────────────────────────────────────────────
  // The gesture is tracked with window listeners from pointerdown on, so a fast first move that
  // leaves the drag zone still counts, and no pointer capture steals clicks from header buttons.
  const drag = useRef<{ active: boolean; detach: () => void } | null>(null)
  const suppressClick = useRef(false)
  const [dragging, setDragging] = useState(false)

  const offsetFor = (vis: number) => max - vis
  const applyOffset = (offset: number) => {
    const el = rootRef.current
    if (el) el.style.transform = `translate3d(0, ${offset}px, 0)`
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!mobile || drag.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    const id = e.pointerId
    const y0 = e.clientY
    const offset0 = offsetFor(visible)
    const samples = [{ t: e.timeStamp, y: e.clientY }]
    const state = { active: false, detach: () => undefined as void }

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      const dy = ev.clientY - y0
      if (!state.active) {
        if (Math.abs(dy) < DRAG_SLOP_PX) return
        state.active = true
        setDragging(true)
      }
      ev.preventDefault()
      const hi = offsetFor(heights[0])
      let off = offset0 + dy
      if (off < 0) off = -rubberband(-off, 60)
      else if (off > hi) off = hi + (dismissible ? off - hi : rubberband(off - hi, 60))
      applyOffset(off)
      samples.push({ t: ev.timeStamp, y: ev.clientY })
      if (samples.length > 6) samples.shift()
    }
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      state.detach()
      drag.current = null
      if (!state.active) return
      // The click that follows this pointerup (if it lands in the zone) must not toggle the grip.
      suppressClick.current = true
      window.setTimeout(() => (suppressClick.current = false), 0)
      setDragging(false)
      if (ev.type === 'pointercancel') {
        applyOffset(offsetFor(visible))
        return
      }
      const first = samples[0]
      const last = samples[samples.length - 1]
      const velocity = -(last.y - first.y) / Math.max(1, last.t - first.t) // px/ms, + = growing
      const released = max - (offset0 + (ev.clientY - y0))
      if (dismissible && onClose && released < heights[0] - DISMISS_PX) {
        onClose()
        return
      }
      const target = resolveSnap(heights, released, velocity)
      // React will not rewrite an unchanged style value, so settle imperatively as well.
      applyOffset(offsetFor(heights[target]))
      if (target !== index) setIndex(target)
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

  useEffect(() => {
    if (!closeOnEscape || !onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && rootRef.current?.contains(document.activeElement)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeOnEscape, onClose])

  // Keep the imperative transform in step with layout changes (rotation, snap list changes).
  useLayoutEffect(() => {
    if (mobile && !drag.current?.active) applyOffset(offsetFor(visible))
  })

  // Mobile: the footer rides at the bottom of the *visible* part, so the body needs its height as padding.
  const footRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const foot = footRef.current
    const root = rootRef.current
    if (!foot || !root || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => root.style.setProperty('--sheet-foot', `${foot.offsetHeight}px`))
    ro.observe(foot)
    return () => ro.disconnect()
  }, [footer != null])

  const dragProps = mobile
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
        transform: `translate3d(0, ${offsetFor(visible)}px, 0)`,
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
      style={style}
    >
      {mobile ? (
        <div className={s.dragZone} {...dragProps}>
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
        <div className={s.head}>
          <div className={s.headMain}>{header}</div>
          {onClose ? <CloseButton label={closeLabel} onClose={onClose} /> : null}
        </div>
      ) : null}
      <div ref={bodyRef} className={cx(s.body, bodyClassName)}>
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
