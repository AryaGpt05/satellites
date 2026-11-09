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
  /** This tab's id (sessionStorage): entries stamped by this tab, in this load or an earlier one, are ours. */
  sid: string
  /** A deep link's first layer ('results'): when it opens on this tab's first entry, a landing goes under it. */
  deep?: string
  /** The address bar for what is on screen: after the app's own moves and after every traversal. */
  onSettled?: () => void
}

export interface BackStack {
  /** A layer opened. */
  open(name: string, close: () => void): LayerToken
  /** A layer closed (by the UI, or by a traversal). */
  closed(token: LayerToken): void
  /** The browser moved (popstate) to an entry with this state. Returns the names of the layers it closed. */
  onPop(state: unknown): string[]
  /** Line the history up with the layers open (after a reload restored fewer layers than it found entries). */
  reconcile(): void
  /** Names of the open layers, bottom first (tests). */
  names(): string[]
}

export const MARK = 'watched-layer'
type Stamp = { s: string; d: number }

/** The stamp on a history state, if it is this tab's. */
export function stampOf(state: unknown, sid: string): Stamp | undefined {
  const m = (state as Record<string, unknown> | null)?.[MARK] as Stamp | undefined
  return m && typeof m === 'object' && m.s === sid && Number.isFinite(m.d) ? m : undefined
}

/** A history state with a stamp, keeping whatever else is there. */
const stamped = (state: unknown, s: string, d: number) => ({ ...((state as object | null) ?? {}), [MARK]: { s, d } })

export function createBackStack(h: HistoryLike, o: BackStackOptions): BackStack {
  const stack: { token: LayerToken; close: () => void; own: boolean }[] = []
  let nextId = 1
  // Where the browser is. A load that finds this tab's stamp on its entry (a reload, a return that was not kept in the
  // back-forward cache) starts at that depth, and the layers it restores from the address (results, a pass) take the
  // entries already there instead of pushing more.
  const found = stampOf(h.state, o.sid)
  /** Depth of the entry in view (0 = this tab's first entry for the site) */
  let cur = found?.d ?? 0
  /** Entries above the base this load found and its first layers adopt */
  let adoptable = cur
  if (!found) h.replaceState(stamped(h.state, o.sid, 0), '')
  /** A deep link on the base entry: its results open over a slipped-in landing */
  let slip = o.deep !== undefined && cur === 0 ? o.deep : undefined
  /** Depth our own history.go is on its way to: until its popstate lands, nothing else moves the history */
  let inFlight: number | null = null
  /** A change arrived while a move was in flight: flush again when it lands */
  let dirty = false
  let scheduled = false

  /** Layers holding an entry of their own */
  const owned = () => stack.reduce((n, e) => n + (e.own ? 1 : 0), 0)

  const flush = () => {
    scheduled = false
    if (inFlight !== null) {
      dirty = true
      return
    }
    adoptable = 0 // the restore is over: from here on, entries follow the layers
    const target = owned()
    if (target > cur) {
      for (let d = cur + 1; d <= target; d++) h.pushState(stamped(null, o.sid, d), '')
      cur = target
      o.onSettled?.()
    } else if (target < cur) {
      // Never below the base (target ≥ 0): the app never navigates off the site itself.
      inFlight = target
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
  /** After a traversal's closes have run: the address bar for what is on screen, and any change that waited. */
  const settle = () =>
    o.schedule(() => {
      o.onSettled?.()
      if (owned() !== cur) change()
    })

  return {
    open(name, close) {
      const token: LayerToken = { id: nextId++, name, popped: false }
      if (slip === name && stack.length === 0) {
        // The deep link's results are opening on the base entry: a landing entry goes under it.
        const url = h.url()
        h.replaceState(stamped(h.state, o.sid, 0), '', '/')
        h.pushState(stamped(null, o.sid, 1), '', url)
        cur = 1
        slip = undefined
        stack.push({ token, close, own: true })
        return token
      }
      slip = undefined
      stack.push({ token, close, own: true })
      if (adoptable > 0) adoptable-- // a restored layer: its entry is already there
      else change()
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
      if (inFlight !== null) {
        const mine = d === inFlight
        inFlight = null
        if (mine) {
          settle()
          if (dirty) {
            dirty = false
            change()
          }
          return []
        }
        // The user moved while ours was in flight: read it as theirs, from where the browser is now.
        dirty = false
      }
      cur = d
      adoptable = 0
      const closedNames: string[] = []
      if (d > owned()) {
        // Forward into an entry whose layer is gone: undo the move, open nothing.
        inFlight = owned()
        cur = owned()
        h.go(owned() - d)
        return closedNames
      }
      while (owned() > d) {
        const top = stack.pop()!
        top.token.popped = true
        top.close()
        closedNames.push(top.token.name)
      }
      settle()
      return closedNames
    },
    reconcile() {
      if (owned() !== cur) change()
    },
    names: () => stack.map((e) => e.token.name),
  }
}

// ───────────────────────────── browser wiring ─────────────────────────────

let instance: BackStack | null = null
let settledListener: (() => void) | null = null
let popListener: ((e: PopStateEvent) => void) | null = null

/** This tab's id: kept for the tab's life (sessionStorage), so a reload knows the entries it pushed before. */
function tabId(): string {
  const key = 'watched.backStack.tab'
  try {
    const v = sessionStorage.getItem(key)
    if (v) return v
    const id = Math.random().toString(36).slice(2, 10)
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return Math.random().toString(36).slice(2, 10)
  }
}

/** The page's back stack (created on first use; inert outside a browser). */
export function backStack(): BackStack | null {
  if (instance || typeof window === 'undefined' || typeof history === 'undefined') return instance
  const deep = location.pathname === '/' && /[?&](q|s)=/.test(location.search)
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
    sid: tabId(),
    deep: deep ? 'results' : undefined,
    onSettled: () => settledListener?.(),
  })
  const s = instance
  popListener = (e) => {
    s.onPop(e.state)
  }
  window.addEventListener('popstate', popListener)
  return instance
}

// Development: a hot update starts a fresh stack (the old listener would keep reading a stale one).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (popListener) window.removeEventListener('popstate', popListener)
    popListener = null
    instance = null
  })
}

/** The app's address-bar writer: called after the back stack's own moves and after every traversal. */
export function onBackSettled(fn: () => void) {
  settledListener = fn
}

/**
 * A layer owned by a component: while `open`, it holds a history entry and Back runs `close`. The latest `close` is
 * used (no need to memoise it). Returns `release`: a close that animates out (the photo viewer's shrink) gives its
 * entry up as the close starts, so a Back during the animation goes to the layer under it.
 */
export function useBackLayer(name: string, open: boolean, close: () => void): () => void {
  const closeRef = useRef(close)
  closeRef.current = close
  const tokenRef = useRef<LayerToken | null>(null)
  const releaseRef = useRef(() => {
    const s = backStack()
    if (s && tokenRef.current) s.closed(tokenRef.current)
    tokenRef.current = null
  })
  useEffect(() => {
    const s = backStack()
    if (!open || !s) return
    tokenRef.current = s.open(name, () => closeRef.current())
    const release = releaseRef.current
    return release
  }, [name, open])
  return releaseRef.current
}

/**
 * A layer driven by store state (results, an open pass): `isOpen` is read on every change, `close` runs on Back.
 * Returns the unsubscribe (which also gives an open layer's entry up).
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
  const unsub = subscribe((state) => {
    const open = isOpen(state)
    if (open && !token) token = s.open(name, close)
    else if (!open && token) {
      s.closed(token)
      token = null
    }
  })
  return () => {
    unsub()
    if (token) s.closed(token)
    token = null
  }
}
