/**
 * The phone's back gesture (and the browser's Back button) closes the top layer instead of leaving the site.
 *
 * Every layer that covers what was there before (the results of a search, an open pass, the photo viewer, the share
 * sheet, About, the phone's search mode) owns ONE history entry while it is open:
 *  - opening it pushes an entry (same URL: the controller keeps writing the address bar with replaceState);
 *  - Back pops that entry and the popstate closes the top layer;
 *  - closing it from the UI (×, swipe down, Esc, "All passes", "New search") pops its entry for it, so the history
 *    never fills with dead entries. Closes in the same tick are batched into one history.go(-n).
 * A deep or share link opens straight onto results: a landing entry is slipped in underneath, so Back from a shared
 * link lands on the site's own landing instead of leaving it (most phone visitors arrive by a link).
 *
 * The stack is authoritative (one entry per open layer, in opening order); history.state only labels entries.
 * Pure core (createBackStack) with the browser wiring around it, so the rules are unit-tested (backStack.test.ts).
 */
import { useEffect, useRef } from 'react'

export interface HistoryLike {
  pushState(data: unknown, unused: string, url?: string | null): void
  replaceState(data: unknown, unused: string, url?: string | null): void
  go(delta: number): void
  readonly state: unknown
}

export interface LayerToken {
  readonly id: number
  readonly name: string
  /** Set when Back closed it: its entry is already gone. */
  popped: boolean
}

export interface BackStack {
  /** A layer opened: push its entry (or adopt the one slipped in for a deep link). */
  open(name: string, close: () => void): LayerToken
  /** A layer closed (by the UI, or by Back): pop its entry if it still has one. */
  closed(token: LayerToken): void
  /** The browser moved back (popstate). Returns the name of the layer it closed, if any. */
  onPop(): string | undefined
  /** Names of the open layers, bottom first (tests, the debug panel). */
  names(): string[]
}

const MARK = 'watched-layer'

/**
 * @param schedule runs the batched history.go after the current task's closes (a microtask in the browser).
 * @param adopt the name of a layer whose entry already exists (a deep link's results), adopted by its first open.
 */
export function createBackStack(h: HistoryLike, schedule: (fn: () => void) => void, adopt?: string): BackStack {
  const stack: { token: LayerToken; close: () => void }[] = []
  let nextId = 1
  /**
   * Net entries to add (> 0) or pop (< 0) at the end of this tick. Entries are interchangeable (only how many there
   * are matters), so a layer closing as another opens (search mode → results on submit) moves nothing: the address
   * bar the controller writes stays on the entry in view.
   */
  let delta = 0
  let scheduled = false
  /** popstate events our own history.go will cause, to ignore */
  let ignorePops = 0
  let adoptable = adopt

  const flush = () => {
    scheduled = false
    const d = delta
    delta = 0
    if (d > 0) for (let i = 0; i < d; i++) h.pushState({ [MARK]: true }, '')
    else if (d < 0) {
      ignorePops++
      h.go(d)
    }
  }
  const change = (d: number) => {
    delta += d
    if (!scheduled) {
      scheduled = true
      schedule(flush)
    }
  }

  return {
    open(name, close) {
      const token: LayerToken = { id: nextId++, name, popped: false }
      // A deep link's results: the entry was pushed at boot, over a landing entry. Adopt it.
      if (!(adoptable === name && stack.length === 0)) change(1)
      adoptable = undefined
      stack.push({ token, close })
      return token
    },
    closed(token) {
      const i = stack.findIndex((e) => e.token === token)
      if (i < 0) return
      stack.splice(i, 1)
      // Back already took its entry; a close from the UI takes it now. Layers closing together (a "New search" over
      // an open pass and photo) each report their own close: one batched history move.
      if (!token.popped) change(-1)
    },
    onPop() {
      if (ignorePops > 0) {
        ignorePops--
        return undefined
      }
      const top = stack.pop()
      if (!top) return undefined
      top.token.popped = true
      top.close()
      return top.token.name
    },
    names: () => stack.map((e) => e.token.name),
  }
}

// ───────────────────────────── browser wiring ─────────────────────────────

let instance: BackStack | null = null

/** The page's back stack (created on first use; inert outside a browser). */
export function backStack(): BackStack | null {
  if (instance || typeof window === 'undefined' || typeof history === 'undefined') return instance
  // A deep or share link on the root path: slip a landing entry in underneath, so Back lands on the landing.
  const deep = location.pathname === '/' && /[?&](q|s)=/.test(location.search)
  if (deep) {
    const url = location.href
    history.replaceState({ [MARK]: true }, '', '/')
    history.pushState(null, '', url)
  }
  instance = createBackStack(history, (fn) => queueMicrotask(fn), deep ? 'results' : undefined)
  const s = instance
  window.addEventListener('popstate', () => {
    s.onPop()
  })
  return instance
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
 * A layer driven by store state (results, an open pass, About): `isOpen` is read on every change, `close` runs on
 * Back. Returns the unsubscribe.
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
