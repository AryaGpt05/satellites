/**
 * The phone's back gesture (and the browser's Back) closes the top layer instead of leaving the site.
 *
 * Every layer that covers what was there before (the results of a search, an open pass, the photo viewer, the share
 * sheet, About, the search modes) owns ONE history entry while it is open. The entries are stamped with this page
 * load's id and their DEPTH (how many layers are open there), so every move is read from where the browser actually is:
 *  - a traversal to depth d (Back, a swipe, a long-press jump over several entries) closes layers, top first, until d
 *    are left open; it never opens anything;
 *  - a Forward into an entry whose layer is gone (depth above what is open) is undone at once: Forward never reopens
 *    and never closes;
 *  - closing a layer from the UI (×, swipe down, Esc, "All passes", "New search") takes its entry off; opens and closes
 *    in one tick net out to one history move (search mode → results moves nothing), and when that move lands the app
 *    is asked to rewrite the address bar for what is on screen (`onSettled`), whatever an earlier write left on the
 *    entry it lands on;
 *  - the app's own moves never go below this load's first entry, so the app itself never navigates off the site.
 * A deep or share link opens straight onto results: when those results actually open, a landing entry is slipped in
 * under them, so Back from a shared link lands on Watched's landing instead of leaving (not on a reload: the history
 * already has its entries).
 *
 * Pure core (createBackStack) with the browser wiring around it; the rules are unit-tested (backStack.test.ts).
 */
import { useEffect, useRef } from 'react'

export interface HistoryLike {
  pushState(data: unknown, unused: string, url?: string | null): void
  replaceState(data: unknown, unused: string, url?: string | null): void
  go(delta: number): void
  readonly state: unknown
  /** The current entry's URL (path + search + hash) */
  url(): string
}

export interface LayerToken {
  readonly id: number
  readonly name: string
  /** Set when a traversal closed it: its entry is already gone. */
  popped: boolean
}

export interface BackStackOptions {
  /** Runs the batched history move after the current tick's opens and closes (a microtask in the browser). */
  schedule: (fn: () => void) => void
  /** This page load's id (entries stamped by another load count as depth 0). */
  sid: string
  /** A deep link's first layer ('results'): it adopts the entry in view instead of pushing one. */
  adopt?: string
  /** Slip a landing entry ('/') under the adopted layer (not on a reload). */
  slipIn?: boolean
  /** The app's own history move has landed: rewrite the address bar for what is on screen. */
  onSettled?: () => void
}

export interface BackStack {
  /** A layer opened. */
  open(name: string, close: () => void): LayerToken
  /** A layer closed (by the UI, or by a traversal). */
  closed(token: LayerToken): void
  /** The browser moved (popstate) to an entry with this state. Returns the names of the layers it closed. */
  onPop(state: unknown): string[]
  /** Names of the open layers, bottom first (tests). */
  names(): string[]
}

export const MARK = 'watched-layer'
type Stamp = { s: string; d: number }

/** The stamp on a history state, if it is this load's. */
export function stampOf(state: unknown, sid: string): Stamp | undefined {
  const m = (state as Record<string, unknown> | null)?.[MARK] as Stamp | undefined
  return m && typeof m === 'object' && m.s === sid && Number.isFinite(m.d) ? m : undefined
}

/** A history state with a stamp, keeping whatever else is there. */
const stamped = (state: unknown, s: string, d: number) => ({ ...((state as object | null) ?? {}), [MARK]: { s, d } })

export function createBackStack(h: HistoryLike, o: BackStackOptions): BackStack {
  const stack: { token: LayerToken; close: () => void; own: boolean }[] = []
  let nextId = 1
  /** Depth of the entry in view (0 = this load's first entry) */
  let cur = 0
  /** Depth our own history.go is on its way to (its popstate is ours, not the user's) */
  let awaiting: number | null = null
  let scheduled = false
  let adopt = o.adopt
  // Label the entry in view as this load's base.
  h.replaceState(stamped(h.state, o.sid, 0), '')

  /** Layers holding an entry of their own (an adopted first layer without a slipped-in landing holds none). */
  const owned = () => stack.reduce((n, e) => n + (e.own ? 1 : 0), 0)

  const flush = () => {
    scheduled = false
    const target = owned()
    if (target > cur) {
      for (let d = cur + 1; d <= target; d++) h.pushState(stamped(null, o.sid, d), '')
      cur = target
      o.onSettled?.()
    } else if (target < cur) {
      // Never below this load's first entry (target ≥ 0): the app never navigates off the site itself.
      awaiting = target
      const n = cur - target
      cur = target
      h.go(-n)
    }
  }
  const change = () => {
    if (scheduled) return
    scheduled = true
    o.schedule(flush)
  }

  return {
    open(name, close) {
      const token: LayerToken = { id: nextId++, name, popped: false }
      let own = true
      if (adopt === name && stack.length === 0) {
        if (o.slipIn) {
          // The deep link's results are opening: a landing entry goes under the entry in view.
          const url = h.url()
          h.replaceState(stamped(h.state, o.sid, 0), '', '/')
          h.pushState(stamped(null, o.sid, 1), '', url)
          cur = 1
        } else own = false
        stack.push({ token, close, own })
        adopt = undefined
        return token
      }
      adopt = undefined
      stack.push({ token, close, own })
      change()
      return token
    },
    closed(token) {
      const i = stack.findIndex((e) => e.token === token)
      if (i < 0) return
      const [e] = stack.splice(i, 1)
      if (!token.popped && e.own) change()
    },
    onPop(state) {
      const d = stampOf(state, o.sid)?.d ?? 0
      if (awaiting !== null) {
        const mine = d === awaiting
        awaiting = null
        if (mine) {
          o.onSettled?.()
          return []
        }
      }
      const closedNames: string[] = []
      if (d > owned()) {
        // Forward into an entry whose layer is gone: undo the move, open nothing.
        awaiting = owned()
        h.go(owned() - d)
        cur = owned()
        return closedNames
      }
      cur = d
      while (owned() > d) {
        const top = stack.pop()!
        top.token.popped = true
        top.close()
        closedNames.push(top.token.name)
      }
      return closedNames
    },
    names: () => stack.map((e) => e.token.name),
  }
}

// ───────────────────────────── browser wiring ─────────────────────────────

let instance: BackStack | null = null
let settledListener: (() => void) | null = null

/** The page's back stack (created on first use; inert outside a browser). */
export function backStack(): BackStack | null {
  if (instance || typeof window === 'undefined' || typeof history === 'undefined') return instance
  const nav = (performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined)?.type
  const fresh = (nav === undefined || nav === 'navigate') && !(history.state as Record<string, unknown> | null)?.[MARK]
  const deep = location.pathname === '/' && /[?&](q|s)=/.test(location.search)
  const sid = Math.random().toString(36).slice(2, 10)
  const h: HistoryLike = {
    pushState: (d, u, url) => history.pushState(d, u, url),
    replaceState: (d, u, url) => history.replaceState(d, u, url),
    go: (n) => history.go(n),
    get state() {
      return history.state
    },
    url: () => location.pathname + location.search + location.hash,
  }
  instance = createBackStack(h, {
    schedule: (fn) => queueMicrotask(fn),
    sid,
    adopt: deep ? 'results' : undefined,
    slipIn: deep && fresh,
    onSettled: () => settledListener?.(),
  })
  const s = instance
  window.addEventListener('popstate', (e) => {
    s.onPop(e.state)
  })
  return instance
}

/** The app's address-bar writer, called when one of the back stack's own history moves has landed. */
export function onBackSettled(fn: () => void) {
  settledListener = fn
}

/**
 * A layer owned by a component: while `open`, it holds a history entry and Back runs `close`. The latest `close` is
 * used (no need to memoise it).
 */
export function useBackLayer(name: string, open: boolean, close: () => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    const s = backStack()
    if (!open || !s) return
    const token = s.open(name, () => closeRef.current())
    return () => s.closed(token)
  }, [name, open])
}

/**
 * A layer driven by store state (results, an open pass): `isOpen` is read on every change, `close` runs on Back.
 * Returns the unsubscribe.
 */
export function watchLayer<S>(
  subscribe: (listener: (state: S, prev: S) => void) => () => void,
  get: () => S,
  name: string,
  isOpen: (state: S) => boolean,
  close: () => void,
): () => void {
  const s = backStack()
  if (!s) return () => undefined
  let token: LayerToken | null = isOpen(get()) ? s.open(name, close) : null
  return subscribe((state) => {
    const open = isOpen(state)
    if (open && !token) token = s.open(name, close)
    else if (!open && token) {
      s.closed(token)
      token = null
    }
  })
}
