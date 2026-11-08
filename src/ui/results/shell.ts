/**
 * Behaviour of the one results panel (decision #10): it persists from computing through results and
 * pass detail; only its contents change, and every change is animated.
 *
 *  useStagedKey     content swaps in two beats: the old content leaves (160 ms), then the new one
 *                   mounts in a transition (interruptible, PERF-04) and enters (240 ms)
 *  useAnimatedHeight  a box whose natural height changes glides to it (240 ms)
 *  useSheetGeometry phones: snap heights measured from the content (grip + header + hero, etc.)
 *  useInsets        publishes the UI's coverage of the viewport for the camera (store.uiInsets);
 *                   phones use publishSheetInset as the Sheet's onVisibleChange
 *  useShellExit     "New search": the panel and the timeline leave instead of vanishing
 */
import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { DUR, EASE } from '@/lib/ease'
import { useApp } from '@/state/store'
import { prefersReducedMotion } from '@/ui/system'

// ── staged swap ──────────────────────────────────────────────────────────────────────────

export const SWAP_OUT_MS = 160

export interface Staged {
  /** The key whose content is mounted */
  shown: string
  /** The key shown before it (to pick the entrance) */
  prev: string
  stage: 'idle' | 'out' | 'in'
}

/**
 * The mounted content follows `target` in two beats: `stage: 'out'` while the old content leaves,
 * then (in a transition, so a heavy mount can yield) `shown` becomes the target with `stage: 'in'`.
 */
export function useStagedKey(target: string): Staged {
  const [st, setSt] = useState<Staged>({ shown: target, prev: target, stage: 'idle' })
  const shownRef = useRef(st.shown)
  shownRef.current = st.shown
  useEffect(() => {
    if (target === shownRef.current) {
      // Back to what is mounted before it finished leaving: just come back in.
      setSt((s) => (s.stage === 'out' ? { ...s, stage: 'in' } : s))
      return
    }
    setSt((s) => ({ ...s, stage: 'out' }))
    const id = window.setTimeout(
      () => startTransition(() => setSt((s) => ({ shown: target, prev: s.shown, stage: 'in' }))),
      SWAP_OUT_MS,
    )
    return () => window.clearTimeout(id)
  }, [target])
  return st
}

// ── animated height ──────────────────────────────────────────────────────────────────────

/**
 * `outer` glides to the natural height of `inner` whenever it changes (240 ms ease-in-out), then
 * releases to auto. Measured, not guessed: the inner box is never height-constrained.
 */
export function useAnimatedHeight(outer: RefObject<HTMLElement | null>, inner: RefObject<HTMLElement | null>, enabled = true) {
  const last = useRef<number | null>(null)
  useLayoutEffect(() => {
    const o = outer.current
    const i = inner.current
    if (!o || !i || typeof ResizeObserver === 'undefined') return
    let anim: Animation | null = null
    const ro = new ResizeObserver(() => {
      const h = i.offsetHeight
      const from = last.current
      last.current = h
      if (!enabled || from === null || Math.abs(from - h) < 2 || prefersReducedMotion()) return
      anim?.cancel()
      anim = o.animate([{ height: `${from}px` }, { height: `${h}px` }], { duration: DUR.sm, easing: EASE.inOut })
      o.style.overflow = 'hidden'
      anim.onfinish = anim.oncancel = () => {
        o.style.overflow = ''
      }
    })
    ro.observe(i)
    return () => {
      ro.disconnect()
      anim?.cancel()
    }
  }, [outer, inner, enabled])
}

// ── phone sheet geometry ─────────────────────────────────────────────────────────────────

export interface SheetGeometry {
  /** The shown content these numbers were measured from ('computing', 'overview', 'photo', 'pass:…') (R2R8) */
  key: string
  /** grip + header (+ border): where the body starts, at the header's natural (target) height */
  top: number
  /** body padding above the content */
  pad: number
  /** footer height (0 without one) */
  foot: number
  /** natural height of the body content */
  content: number
  /** bottom of [data-peek-end] inside the content (overview hero), if present */
  peekEnd?: number
  /** bottom of [data-image-end] inside the content (pass image + caption), if present */
  imageEnd?: number
}

const BODY_PAD_TOP = 20

/**
 * Measures the mobile sheet: the body's offset (grip + header), the footer, and where the content's
 * marked blocks end. Re-measures on any size change of the header, body content or footer.
 */
/** The last computing snap measured (px), for a computing view whose readout isn't measured yet (R2R8). */
let computingSnapPx: number | undefined
export const rememberComputingSnap = (px: number) => void (computingSnapPx = px)
export const lastComputingSnapPx = () => computingSnapPx

export function useSheetGeometry(
  bodyRef: RefObject<HTMLDivElement | null>,
  innerRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  key: string,
  deps: unknown[],
): SheetGeometry | null {
  const keyRef = useRef(key)
  keyRef.current = key
  const [geo, setGeo] = useState<SheetGeometry | null>(null)
  const measured = useRef(false)
  const measure = useCallback(() => {
    const body = bodyRef.current
    const inner = innerRef.current
    if (!body || !inner) return
    const foot = body.nextElementSibling as HTMLElement | null
    // A header gliding to a new height (useAnimatedHeight) counts at its target height, so the snaps
    // move once, not every frame of the glide.
    const section = body.parentElement
    const outer = section?.querySelector<HTMLElement>('[data-anim-outer]')
    const natural = section?.querySelector<HTMLElement>('[data-anim-inner]')
    const top = body.offsetTop + (outer && natural ? natural.offsetHeight - outer.offsetHeight : 0)
    const pad = parseFloat(getComputedStyle(body).paddingTop) || BODY_PAD_TOP
    const innerTop = inner.getBoundingClientRect().top
    const end = (sel: string) => {
      const el = inner.querySelector<HTMLElement>(sel)
      return el ? el.getBoundingClientRect().bottom - innerTop : undefined
    }
    const next: SheetGeometry = {
      key: keyRef.current,
      top,
      pad,
      foot: foot?.offsetHeight ?? 0,
      content: inner.offsetHeight,
      peekEnd: end('[data-peek-end]'),
      imageEnd: end('[data-image-end]'),
    }
    setGeo((g) =>
      g &&
      g.key === next.key &&
      Math.abs(g.top - next.top) < 2 &&
      g.pad === next.pad &&
      Math.abs(g.foot - next.foot) < 2 &&
      Math.abs(g.content - next.content) < 2 &&
      Math.abs((g.peekEnd ?? -1) - (next.peekEnd ?? -1)) < 2 &&
      Math.abs((g.imageEnd ?? -1) - (next.imageEnd ?? -1)) < 2
        ? g
        : next,
    )
  }, [bodyRef, innerRef])

  useLayoutEffect(() => {
    if (!enabled) return
    const body = bodyRef.current
    const inner = innerRef.current
    if (!body || !inner || typeof ResizeObserver === 'undefined') return
    // The first measure is synchronous, so the sheet's first frame sits at its measured snap. Later
    // content changes (the results handoff, a pass) are measured from the observer's first callback,
    // after layout: no forced layout inside the commit that mounts the new content.
    if (!measured.current) {
      measured.current = true
      measure()
    }
    const ro = new ResizeObserver(() => measure())
    ro.observe(inner)
    const head = body.previousElementSibling
    if (head) ro.observe(head)
    const foot = body.nextElementSibling
    if (foot) ro.observe(foot)
    // Marked blocks can resize without the content box changing (an image's aspect box filling in).
    inner.querySelectorAll('[data-peek-end], [data-image-end]').forEach((el) => ro.observe(el))
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, measure, ...deps])
  return geo
}


// ── insets for the camera ────────────────────────────────────────────────────────────────

/**
 * Publishes what the results UI covers (store.uiInsets) so the camera frames the subject in what is
 * left. Desktop: the dock on the right and the timeline strip at the bottom (0 when the strip sits
 * beside the panel or inside it). Phones publish from the Sheet's own `onVisibleChange` instead
 * (see `publishSheetInset`): the visible height, live while dragged or settling.
 */
export function useInsets(sectionRef: RefObject<HTMLElement | null>, timelineRef: RefObject<HTMLElement | null>, mobile: boolean, deps: unknown[]) {
  useLayoutEffect(() => {
    const section = sectionRef.current
    if (!section || mobile) return
    const set = useApp.getState().setUiInsets
    const publish = () => {
      // R2R9: the panel's LAYOUT position (offsetLeft ignores the dock-in translate), so the computing flight
      // is aimed at the results layout from its first frame.
      const right = Math.max(0, window.innerWidth - section.offsetLeft + 24)
      const tl = timelineRef.current?.getBoundingClientRect()
      let bottom: number
      if (tl && tl.height) bottom = Math.max(0, window.innerHeight - tl.top)
      else {
        // Computing (no strip yet): the strip's CSS geometry. It covers the bottom band both under the panel
        // and beside it (short desktops), so this is right in both layouts.
        const cs = getComputedStyle(section)
        const px = (v: string) => parseFloat(cs.getPropertyValue(v)) || 0
        bottom = px('--bezel-inset') + px('--timeline-bottom') + px('--timeline-h')
      }
      set({ right, bottom, left: 0 })
    }
    // First publish from the observer's first callback (after layout, same frame): no forced layout.
    if (typeof ResizeObserver === 'undefined') publish()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null
    ro?.observe(section)
    if (timelineRef.current) ro?.observe(timelineRef.current)
    window.addEventListener('resize', publish)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', publish)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionRef, timelineRef, mobile, ...deps])
}

/** Phones: the Sheet's visible height (px from the bottom, every frame while it moves) is the inset. */
export function publishSheetInset(px: number) {
  useApp.getState().setUiInsets({ bottom: Math.max(0, px), left: 0, right: 0 })
}

// ── exit ────────────────────────────────────────────────────────────────────────────────

/** Unmounts sooner than this after mounting are not animated (StrictMode's simulated unmount). */
const MIN_LIFETIME_MS = 48

/**
 * When the results shell leaves for good (New search → landing, an error), its panel and timeline
 * exit as clones: desktop clips away to the right (mirroring the dock's entrance), phones slide down.
 * A remount within the results flow (computing → results in the current composition) is not an exit.
 */
export function useShellExit(sectionRef: RefObject<HTMLElement | null>, timelineRef: RefObject<HTMLElement | null>, mobile: boolean) {
  const mobileRef = useRef(mobile)
  mobileRef.current = mobile
  useLayoutEffect(() => {
    const mountedAt = performance.now()
    const section = sectionRef.current
    const timeline = timelineRef.current
    return () => {
      const phase = useApp.getState().phase
      lastShellUnmount = { at: performance.now(), phase }
      if (phase === 'computing' || phase === 'results') return
      if (performance.now() - mountedAt < MIN_LIFETIME_MS) return
      const reduced = prefersReducedMotion()
      const phone = mobileRef.current
      exitClone(
        sectionRef.current ?? section,
        reduced
          ? [{ opacity: 1 }, { opacity: 0 }]
          : phone
            ? [{ translate: '0 0' }, { translate: '0 100%' }]
            : [
                { clipPath: 'inset(0 0 0 0)', translate: '0 0' },
                { clipPath: 'inset(0 0 0 100%)', translate: '16px 0' },
              ],
        reduced ? 200 : 320,
      )
      exitTimeline(timelineRef.current ?? timeline)
    }
  }, [sectionRef, timelineRef])
}

/** The timeline strip leaves by clipping away to the right (mirror of its wipe in), 280 ms; reduced: a fade. */
export function exitTimeline(node: HTMLElement | null | undefined) {
  const reduced = prefersReducedMotion()
  exitClone(node, reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(0 0 0 100%)' }], reduced ? 200 : 280)
}

function exitClone(node: HTMLElement | null | undefined, keyframes: Keyframe[], duration: number) {
  const parent = node?.parentNode
  if (!node || !parent || !node.isConnected || typeof node.animate !== 'function') return
  const clone = node.cloneNode(true) as HTMLElement
  clone.setAttribute('aria-hidden', 'true')
  clone.removeAttribute('id')
  clone.inert = true
  clone.style.pointerEvents = 'none'
  clone.style.animation = 'none'
  clone.querySelectorAll<HTMLElement>('*').forEach((el) => {
    el.style.animation = 'none'
    el.removeAttribute('id')
  })
  // Canvases clone blank: carry their pixels over.
  const src = node.querySelectorAll('canvas')
  clone.querySelectorAll('canvas').forEach((c, i) => {
    const from = src[i]
    if (!from || !from.width || !from.height) return
    try {
      c.width = from.width
      c.height = from.height
      c.getContext('2d')?.drawImage(from, 0, 0)
    } catch {
      /* tainted or lost context: the clone shows the frame without pixels */
    }
  })
  // Keep scrolled content where it was (R2R9): read the offsets BEFORE inserting (no layout of the clone
  // in between), then write only the non-zero ones.
  const a = node.querySelectorAll<HTMLElement>('*')
  const scrolled: [number, number, number][] = []
  a.forEach((el, i) => {
    const t = el.scrollTop
    const l = el.scrollLeft
    if (t || l) scrolled.push([i, t, l])
  })
  parent.insertBefore(clone, node.nextSibling)
  if (scrolled.length) {
    const b = clone.querySelectorAll<HTMLElement>('*')
    for (const [i, t, l] of scrolled) {
      const el = b[i]
      if (!el) continue
      if (t) el.scrollTop = t
      if (l) el.scrollLeft = l
    }
  }
  const anim = clone.animate(keyframes, { duration, easing: EASE.inOut, fill: 'forwards' })
  const remove = () => clone.remove()
  anim.onfinish = remove
  anim.oncancel = remove
  window.setTimeout(remove, duration + 1000)
}

/** The last time a results shell unmounted, and the phase then (continuity across a remount). */
export let lastShellUnmount = { at: -Infinity, phase: '' as string }
