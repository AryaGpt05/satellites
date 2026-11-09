import { describe, expect, it } from 'vitest'
import { createBackStack, resolveTabId, stampOf, type BackStack, type HistoryLike } from './backStack'

/**
 * A session history for one tab, asynchronous like a browser's: a traversal (`go`, or the user's Back / Forward) is
 * queued, and resolved RELATIVE TO THE ENTRY CURRENT WHEN IT IS PROCESSED (`deliver()`, a later task), landing with a
 * popstate carrying that entry's state. One the user queued earlier is processed first (`jumpFirst`); an app move can
 * be lost (`dropApp`); with `chromium`, an app move requested while a user traversal is pending is dropped. Moving
 * below the first entry leaves the site: counted when the APP's move does it (`leftSite`); a user Back there does
 * nothing (first entry in the tab). Out of range above: nothing happens.
 *
 * Three models of when a traversal's target is fixed, none of them verified in every browser (CR-3):
 *  - 'delivery' (default): relative to the entry current when it is processed;
 *  - 'callTime': the target entry is picked when go() / Back is called (gone if truncated meanwhile);
 *  - 'queuedPush': like 'delivery', but a pushState made while a traversal is pending is applied after it.
 */
type HistoryModel = 'delivery' | 'callTime' | 'queuedPush'
const MODELS: HistoryModel[] = ['delivery', 'callTime', 'queuedPush']
function fakeHistory(first = '/', opts: { chromium?: boolean; model?: HistoryModel } = {}) {
  const model = opts.model ?? 'delivery'
  type Entry = { state: unknown; url: string }
  const entries: Entry[] = [{ state: null, url: first }]
  let index = 0
  let onPop: ((state: unknown) => void) | null = null
  type Op = { delta: number; byApp: boolean; held?: boolean; target?: Entry | 'off'; push?: Entry }
  const pending: Op[] = []
  let slowApp = false
  const log = { leftSite: 0, gos: [] as number[], pops: 0 }
  const traverse = (delta: number, byApp: boolean, first = false) => {
    if (delta === 0) return
    const op: Op = { delta, byApp }
    if (model === 'callTime') op.target = index + delta < 0 ? 'off' : entries[index + delta]
    if (first) pending.unshift(op)
    else pending.push(op)
  }
  const doPush = (e: Entry) => {
    entries.splice(index + 1)
    entries.push(e)
    index++
  }
  const h = {
    get state() {
      return entries[index].state
    },
    url: () => entries[index].url,
    pushState(state: unknown, _u: string, url?: string | null) {
      const e = { state, url: url ?? entries[index].url }
      if (model === 'queuedPush' && pending.some((t) => !t.push)) pending.push({ delta: 0, byApp: true, push: e })
      else doPush(e)
    },
    replaceState(state: unknown, _u: string, url?: string | null) {
      entries[index] = { state, url: url ?? entries[index].url }
    },
    go(delta: number) {
      log.gos.push(delta)
      // Chromium: an app history.go requested while a user traversal is pending is dropped.
      if (opts.chromium && pending.some((t) => !t.byApp && !t.push)) return
      traverse(delta, true)
      if (slowApp && delta !== 0) pending[pending.length - 1].held = true
    },
    /** The user's Back / Forward / long-press jump */
    jump: (delta: number) => traverse(delta, false),
    /** A user move queued before the app's queued ones (pressed during a long task) */
    jumpFirst: (delta: number) => traverse(delta, false, true),
    /** The browser drops the app's queued move */
    dropApp() {
      const i = pending.findIndex((t) => t.byApp && !t.push)
      if (i >= 0) pending.splice(i, 1)
    },
    queued: () => pending.length,
    /** The app's queued moves are slow (a long task, a backgrounded tab): not processed until `releaseApp` */
    holdApp() {
      slowApp = true
      pending.forEach((t) => t.byApp && !t.push && (t.held = true))
    },
    releaseApp() {
      slowApp = false
      pending.forEach((t) => (t.held = false))
    },
    back: () => traverse(-1, false),
    forward: () => traverse(1, false),
    /** Land the traversals in flight (a later task). */
    deliver() {
      let moved = false
      while (pending.length && !pending[0].held) {
        const t = pending.shift()!
        if (t.push) {
          doPush(t.push)
          continue
        }
        let i = index + t.delta
        if (t.target === 'off') i = -1
        else if (t.target) {
          i = entries.indexOf(t.target)
          if (i < 0) continue // its entry was truncated: nothing happens
        }
        if (i < 0) {
          if (t.byApp) log.leftSite++
          continue
        }
        if (i >= entries.length) continue
        if (i === index && t.target) continue // already there: no traversal, no popstate
        index = i
        log.pops++
        onPop?.(entries[index].state)
        moved = true
      }
      return moved
    },
    index: () => index,
    length: () => entries.length,
    listen(fn: (state: unknown) => void) {
      onPop = fn
    },
    log,
    urlAt: (i: number) => entries[i].url,
  }
  return h satisfies HistoryLike
}
type FakeHistory = ReturnType<typeof fakeHistory>

/**
 * One page load of the app over a history: layers that report their own closes, an address-bar writer like Main's
 * (?q=…&p=…) run on store changes (before the stack's batched move, as zustand calls it) and on onSettled.
 */
function load(h: FakeHistory, opts: { deep?: boolean; place?: string; pass?: string } = {}) {
  const micro: (() => void)[] = []
  let clock = 0
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  const later = (fn: () => void, ms: number) => {
    const t = { at: clock + ms, fn, live: true }
    timers.push(t)
    return () => void (t.live = false)
  }
  /** Run the timers due by now (in order), once */
  const runDue = () => {
    const due = timers.filter((t) => t.live && t.at <= clock).sort((a, b) => a.at - b.at)
    for (const t of due) {
      t.live = false
      t.fn()
    }
    return due.length > 0
  }
  const app = { place: opts.place ?? '', pass: opts.pass ?? '' }
  const appUrl = () => (app.place ? `/?q=${app.place}${app.pass ? `&p=${app.pass}` : ''}` : '/')
  const writeUrl = () => h.replaceState(h.state, '', appUrl())
  const closed: string[] = []
  const tokens = new Map<string, ReturnType<BackStack['open']>>()
  const s: BackStack = createBackStack(h, {
    schedule: (fn) => void micro.push(fn),
    later,
    sid: 'tab1',
    deep: opts.deep ? 'results' : undefined,
    onSettled: writeUrl,
  })
  h.listen((state) => s.onPop(state))
  const close = (name: string) => {
    if (name === 'pass') app.pass = ''
    if (name === 'results') app.place = app.pass = ''
    if (name === 'pass' || name === 'results') writeUrl()
  }
  const open = (name: string) => {
    if (name === 'results') app.place = app.place || 'paris'
    if (name === 'pass') app.pass = 'P1'
    if (name === 'results' || name === 'pass') writeUrl()
    tokens.set(
      name,
      s.open(name, () => {
        closed.push(name)
        close(name)
        s.closed(tokens.get(name)!)
      }),
    )
  }
  /** A close from the UI (×, "All passes", "New search"): the app changes, then the layer reports it. */
  const uiClose = (name: string) => {
    close(name)
    s.closed(tokens.get(name)!)
  }
  const endTick = () => {
    while (micro.length) micro.splice(0).forEach((f) => f())
  }
  /** Run microtasks, deliver traversals and run zero-delay tasks until nothing is left (the tick and the tasks after it). */
  const settle = () => {
    for (let i = 0; i < 50; i++) {
      const ran = micro.length > 0
      endTick()
      const moved = h.deliver()
      endTick()
      const timed = runDue()
      if (!moved && !ran && !timed && micro.length === 0) return
    }
  }
  /** Time passes (the move timeout) */
  const elapse = (ms: number) => {
    clock += ms
    runDue()
    settle()
  }
  /** The app's own tasks only (microtasks and zero-delay timers), no traversal delivered */
  const appTasks = () => {
    for (let i = 0; i < 10; i++) {
      endTick()
      if (!runDue() && micro.length === 0) return
    }
  }
  return { s, open, uiClose, closed, app, appUrl, settle, elapse, appTasks, endTick }
}

describe('back stack: Back closes the top layer, never leaves the site', () => {
  it('one entry per layer; Back closes them top-down and stays on the site', () => {
    const h = fakeHistory()
    const { s, open, closed, settle } = load(h)
    open('results')
    settle()
    open('pass')
    settle()
    open('lightbox')
    settle()
    expect(h.index()).toBe(3)
    for (let i = 0; i < 3; i++) {
      h.back()
      settle()
    }
    expect(closed).toEqual(['lightbox', 'pass', 'results'])
    expect(s.names()).toEqual([])
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
    expect(h.log.leftSite).toBe(0)
  })

  it('a jump over several entries closes every layer above it (H4)', () => {
    const h = fakeHistory()
    const { s, open, closed, settle } = load(h)
    open('results')
    open('pass')
    open('lightbox')
    settle()
    h.jump(-2)
    settle()
    expect(closed).toEqual(['lightbox', 'pass'])
    expect(s.names()).toEqual(['results'])
    expect(h.url()).toBe('/?q=paris')
  })

  it('Forward never closes or reopens: a Forward into a closed layer is undone (H1)', () => {
    const h = fakeHistory()
    const { s, open, closed, settle } = load(h)
    open('results')
    settle()
    open('pass')
    settle()
    h.back()
    settle()
    h.forward()
    settle()
    expect(closed).toEqual(['pass'])
    expect(s.names()).toEqual(['results'])
    expect(h.index()).toBe(1)
    expect(h.url()).toBe('/?q=paris')
    h.back()
    settle()
    expect(s.names()).toEqual([])
    expect(h.url()).toBe('/')
  })

  it('a pass closed from the UI leaves the address on the list (H2)', () => {
    const h = fakeHistory()
    const { open, uiClose, settle } = load(h)
    open('results')
    settle()
    open('pass')
    settle()
    expect(h.url()).toBe('/?q=paris&p=P1')
    uiClose('pass')
    settle()
    expect(h.index()).toBe(1)
    expect(h.url()).toBe('/?q=paris')
    h.back()
    settle()
    expect(h.url()).toBe('/')
  })

  it('pass → search from the pass header (entry reused) → Back: the list, with the list’s address', () => {
    const h = fakeHistory()
    const { s, open, uiClose, settle } = load(h)
    open('results')
    settle()
    open('pass') // the ?p= writer runs before the push: the list's entry carries &p= for now
    settle()
    uiClose('pass') // openSearch: the pass closes and the search opens in one tick (the search reuses the entry)
    open('search')
    settle()
    expect(h.index()).toBe(2)
    h.back() // closes the search: the list's entry, still written with &p=
    settle()
    expect(s.names()).toEqual(['results'])
    expect(h.url()).toBe('/?q=paris')
  })

  it('never moves the history while its own move is in flight: close then open before it lands (P0)', () => {
    const h = fakeHistory()
    const { s, open, uiClose, endTick, settle } = load(h)
    open('search') // landing search mode
    settle()
    uiClose('search') // the blur ends it: go(-1) is now in flight
    endTick()
    open('about') // "How this works", ~20 ms later, before the traversal lands
    endTick()
    settle()
    expect(s.names()).toEqual(['about'])
    expect(h.index()).toBe(1)
    // About's Close (a UI close) and the Back after it both stay on the site
    uiClose('about')
    settle()
    expect(h.index()).toBe(0)
    expect(h.log.leftSite).toBe(0)
  })

  it('two closes in flight land at the right depth', () => {
    const h = fakeHistory()
    const { s, open, uiClose, endTick, settle } = load(h)
    open('results')
    open('pass')
    settle()
    uiClose('pass')
    endTick() // go(-1) in flight
    uiClose('results')
    endTick() // waits for it
    settle()
    expect(s.names()).toEqual([])
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
    expect(h.log.leftSite).toBe(0)
  })

  it('layers closing together (New search over a pass and a photo) leave in one move', () => {
    const h = fakeHistory()
    const { s, open, uiClose, settle } = load(h)
    open('results')
    open('pass')
    open('lightbox')
    settle()
    uiClose('lightbox')
    uiClose('pass')
    uiClose('results')
    settle()
    expect(h.log.gos).toEqual([-3])
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
    expect(s.names()).toEqual([])
  })

  it('a layer closing as another opens moves nothing (search mode → results keeps the address bar)', () => {
    const h = fakeHistory()
    const { s, open, uiClose, settle } = load(h)
    open('search')
    settle()
    open('results')
    uiClose('search')
    settle()
    expect(h.index()).toBe(1)
    expect(h.url()).toBe('/?q=paris')
    expect(s.names()).toEqual(['results'])
  })

  it('a deep link opens over a slipped-in landing: Back lands on the landing (H3, first entry in the tab)', () => {
    const h = fakeHistory('/?q=paris')
    const { s, open, uiClose, settle } = load(h, { deep: true, place: 'paris' })
    h.back() // a Back during boot on the tab's first entry: nothing
    settle()
    open('results')
    settle()
    expect(h.index()).toBe(1)
    expect(h.urlAt(0)).toBe('/')
    uiClose('results') // CANCEL while computing
    settle()
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
    expect(s.names()).toEqual([])
    expect(h.log.leftSite).toBe(0)
  })

  it('an expired share opens no results: nothing slipped in (H6)', () => {
    const h = fakeHistory('/?s=expired')
    const { open, settle } = load(h, { deep: true })
    open('search')
    settle()
    expect(h.length()).toBe(2)
    expect(h.urlAt(0)).toBe('/?s=expired')
  })
})

describe('back stack across loads of the same tab (reloads, returns the back-forward cache did not keep)', () => {
  it('reload on a deep link’s results: Back still reaches the landing (repro A)', () => {
    const h = fakeHistory('/?q=waterloo')
    const a = load(h, { deep: true, place: 'waterloo' })
    a.open('results')
    a.settle()
    // reload: the same history, a new load restoring the results from the address
    const b = load(h, { deep: true, place: 'waterloo' })
    b.open('results')
    b.settle()
    expect(h.length()).toBe(2)
    h.back()
    b.settle()
    expect(b.s.names()).toEqual([])
    expect(h.url()).toBe('/')
    expect(h.index()).toBe(0)
  })

  it('reloads on an open pass add no entries, and every Back closes something (repro B)', () => {
    const h = fakeHistory()
    const a = load(h)
    a.open('results')
    a.settle()
    a.open('pass')
    a.settle()
    let b = a
    for (let i = 0; i < 2; i++) {
      b = load(h, { place: 'paris', pass: 'P1' })
      b.open('results')
      b.open('pass')
      b.settle()
    }
    expect(h.length()).toBe(3)
    h.back()
    b.settle()
    expect(b.s.names()).toEqual(['results'])
    expect(h.url()).toBe('/?q=paris')
    h.back()
    b.settle()
    expect(b.s.names()).toEqual([])
    expect(h.url()).toBe('/')
  })

  it('reload on the landing, then Forward into old results: undone, the landing keeps its address (repro C)', () => {
    const h = fakeHistory()
    const a = load(h)
    a.open('results')
    a.settle()
    h.back()
    a.settle()
    const b = load(h) // reload on the landing
    b.settle()
    h.forward()
    b.settle()
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
    expect(b.s.names()).toEqual([])
  })

  it('a reload that restores fewer layers than it found lines the history up', () => {
    const h = fakeHistory()
    const a = load(h)
    a.open('results')
    a.open('pass')
    a.settle()
    const b = load(h, { place: 'paris' }) // the pass is no longer in the report: only the results come back
    b.open('results')
    b.settle()
    b.s.reconcile()
    b.settle()
    expect(h.index()).toBe(1)
    h.back()
    b.settle()
    expect(b.s.names()).toEqual([])
    expect(h.url()).toBe('/')
  })

  it('left during boot, back with Forward: the deep link still opens over a landing (new-2)', () => {
    const h = fakeHistory('/?q=paris')
    load(h, { deep: true }) // the first load stamps the entry and is left before its results open
    const b = load(h, { deep: true, place: 'paris' })
    b.open('results')
    b.settle()
    h.back()
    b.settle()
    expect(h.url()).toBe('/')
    expect(b.s.names()).toEqual([])
  })

  it('reload with a landing layer open (About, search mode): the landing restores none, the first Back is not dead (N1)', () => {
    const h = fakeHistory()
    const a = load(h)
    a.open('about')
    a.settle()
    expect(h.index()).toBe(1)
    const b = load(h) // reload: boot settles on the landing, nothing comes back
    b.settle()
    b.s.reconcile() // Main: boot → idle (or error)
    b.settle()
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
    expect(h.log.leftSite).toBe(0)
    // a layer opened now gets an entry of its own, and Back closes it
    b.open('search')
    b.settle()
    expect(h.index()).toBe(1)
    h.back()
    b.settle()
    expect(b.closed).toEqual(['search'])
    expect(h.index()).toBe(0)
  })

  it('stamps entries with this tab and their depth; another tab’s stamps read as depth 0', () => {
    const h = fakeHistory()
    const { open, settle } = load(h)
    open('results')
    settle()
    expect(stampOf(h.state, 'tab1')).toEqual({ s: 'tab1', d: 1 })
    expect(stampOf(h.state, 'tab2')).toBeUndefined()
  })
})

describe('back stack: layers stack in their drawn order', () => {
  it('a pass selected while About is up goes under About: Back closes About, then the pass (F2)', () => {
    const h = fakeHistory('/?s=abcdefgh')
    const { s, open, closed, settle, app } = load(h, { deep: true, place: 'paris' })
    open('results') // computing a share link
    settle()
    open('about') // "How this works" while it computes
    settle()
    open('pass') // the share's pass, selected as the results land
    settle()
    expect(s.names()).toEqual(['results', 'pass', 'about'])
    expect(h.index()).toBe(3)
    h.back()
    settle()
    expect(closed).toEqual(['about'])
    expect(app.pass).toBe('P1')
    expect(h.url()).toBe('/?q=paris&p=P1')
    h.back()
    settle()
    expect(closed).toEqual(['about', 'pass'])
    expect(h.url()).toBe('/?q=paris')
    h.back()
    settle()
    expect(h.url()).toBe('/')
    expect(h.log.leftSite).toBe(0)
  })

  it('About is drawn over the photo viewer (both on <body>, CR-7): Back closes About first, whichever opened first', () => {
    const h = fakeHistory()
    const { s, open, settle } = load(h)
    open('results')
    open('pass')
    open('lightbox')
    open('about') // "?" over the viewer
    settle()
    expect(s.names()).toEqual(['results', 'pass', 'lightbox', 'about'])
    const h2 = fakeHistory()
    const b = load(h2)
    b.open('results')
    b.open('about')
    b.open('lightbox') // never from the UI today; if it were, it would sit under About
    b.settle()
    expect(b.s.names()).toEqual(['results', 'lightbox', 'about'])
  })

  it('same rank, or an unknown name, goes on top', () => {
    const h = fakeHistory()
    const { s, open, settle } = load(h)
    open('results')
    open('share')
    open('lightbox') // drawn under the share sheet
    open('popover') // unknown: on top
    settle()
    expect(s.names()).toEqual(['results', 'lightbox', 'share', 'popover'])
    expect(h.index()).toBe(4)
  })

  it('a layer under another, closed from the UI, takes one entry off and keeps the rest in order', () => {
    const h = fakeHistory()
    const { s, open, uiClose, closed, settle } = load(h)
    open('results')
    open('about')
    open('pass')
    settle()
    uiClose('pass')
    settle()
    expect(s.names()).toEqual(['results', 'about'])
    expect(h.index()).toBe(2)
    h.back()
    settle()
    expect(closed).toEqual(['about'])
    expect(s.names()).toEqual(['results'])
  })
})

describe('tab id (F4: storage blocked)', () => {
  const store = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }
  const blocked = {
    getItem: () => {
      throw new Error('SecurityError')
    },
    setItem: () => {
      throw new Error('SecurityError')
    },
  }
  let n = 0
  const mint = () => `mint${++n}`

  it('sessionStorage first, kept across loads', () => {
    const st = store()
    const win = { name: '' }
    const a = resolveTabId(st, null, win, mint)
    expect(resolveTabId(st, null, { name: '' }, mint)).toBe(a)
    expect(win.name).toBe('') // storage works: nothing in window.name (CR-5)
  })

  it('storage blocked: the stamp on the entry in view, then window.name, before minting', () => {
    const win = { name: '' }
    const first = resolveTabId(blocked, null, win, mint)
    // reload on a stamped entry
    expect(resolveTabId(blocked, { 'watched-layer': { s: first, d: 2 } }, { name: '' }, mint)).toBe(first)
    // reload on an entry the app never stamped (another page's state): window.name carries it
    expect(resolveTabId(blocked, null, win, mint)).toBe(first)
    expect(resolveTabId(null, null, win, mint)).toBe(first)
  })

  it('a reload with storage blocked still adopts its entries: Back closes the layer (no dead Back)', () => {
    const h = fakeHistory()
    const win = { name: '' }
    const sidA = resolveTabId(blocked, h.state, win, mint)
    const micro: (() => void)[] = []
    const run = () => {
      for (let i = 0; i < 10; i++) {
        micro.splice(0).forEach((f) => f())
        if (!h.deliver() && micro.length === 0) return
      }
    }
    const a = createBackStack(h, { schedule: (f) => void micro.push(f), sid: sidA })
    h.listen((st) => a.onPop(st))
    a.open('results', () => undefined)
    run()
    expect(h.index()).toBe(1)
    const sidB = resolveTabId(blocked, h.state, win, mint)
    expect(sidB).toBe(sidA)
    const b = createBackStack(h, { schedule: (f) => void micro.push(f), sid: sidB })
    h.listen((st) => b.onPop(st))
    const closedB: string[] = []
    const t = b.open('results', () => {
      closedB.push('results')
      b.closed(t)
    })
    run()
    expect(h.length()).toBe(2)
    h.back()
    run()
    expect(closedB).toEqual(['results'])
  })

  it('never clobbers a window.name it did not write; ignores malformed ids', () => {
    const win = { name: 'someone-else' }
    const id = resolveTabId(blocked, { 'watched-layer': { s: '<bad id>', d: 1 } }, win, mint)
    expect(id).toMatch(/^mint\d+$/)
    expect(win.name).toBe('someone-else')
  })
})

describe('back stack: user traversals racing the app’s own moves (history.go resolves when the browser gets to it)', () => {
  it('a Back right after a close from the UI still closes the next layer (Chromium drops a later app go)', () => {
    for (const chromium of [true, false]) {
      const h = fakeHistory('/', { chromium })
      const { s, open, uiClose, closed, settle, endTick } = load(h)
      open('results')
      open('pass')
      open('lightbox')
      settle()
      uiClose('lightbox') // the photo viewer's ×…
      endTick() // …moves in its own tick
      expect(h.log.gos).toEqual([-1])
      h.back() // …and a Back right after it
      settle()
      expect(closed).toEqual(['pass'])
      expect(s.names()).toEqual(['results'])
      expect(h.index()).toBe(1)
      expect(h.url()).toBe('/?q=paris')
      expect(h.log.leftSite).toBe(0)
    }
  })

  it('a user Back processed before the app’s queued move: the app’s lands back on the user’s entry, never off the site', () => {
    const h = fakeHistory()
    const { s, open, uiClose, settle, appTasks } = load(h)
    open('results')
    open('pass')
    settle()
    uiClose('pass')
    uiClose('results') // New search: both close, one go(-2)
    appTasks()
    expect(h.log.gos).toEqual([-2])
    h.jumpFirst(-1) // a Back pressed before it, processed first
    settle()
    expect(h.log.leftSite).toBe(0)
    expect(s.names()).toEqual([])
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
  })

  it('a user Forward processed before the app’s queued move: read once it lands, nothing reopens', () => {
    const h = fakeHistory()
    const { s, open, uiClose, closed, settle, appTasks } = load(h)
    open('results')
    settle()
    open('pass')
    settle()
    h.back() // pass closes; its entry is a dead Forward now
    settle()
    uiClose('results') // New search: go(-1)
    appTasks()
    h.jumpFirst(1) // Forward, processed first
    settle()
    expect(h.log.leftSite).toBe(0)
    expect(closed).toEqual(['pass'])
    expect(s.names()).toEqual([])
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
  })

  it('Forward into a dead entry, then Back, both landing before the undo: the undo is not issued (no leaving)', () => {
    const h = fakeHistory()
    const { s, open, settle, endTick } = load(h)
    open('results')
    settle()
    h.back()
    settle()
    expect(h.index()).toBe(0)
    h.forward()
    h.back()
    // the browser processes both before the app's next task
    h.deliver()
    endTick()
    h.deliver()
    settle()
    expect(h.log.leftSite).toBe(0)
    expect(h.log.gos).toEqual([])
    expect(h.index()).toBe(0)
    expect(s.names()).toEqual([])
  })

  it('an app move landing after the timeout is never issued twice: "All passes" closes exactly one layer (RS-1)', () => {
    const h = fakeHistory()
    const { s, open, uiClose, closed, settle, endTick, elapse } = load(h)
    open('results')
    open('pass')
    settle()
    uiClose('pass')
    endTick()
    expect(h.log.gos).toEqual([-1])
    h.holdApp() // a long task: the go lands 1.5 s later
    elapse(1500)
    h.releaseApp()
    settle()
    expect(h.log.gos).toEqual([-1])
    expect(closed).toEqual([])
    expect(s.names()).toEqual(['results'])
    expect(h.index()).toBe(1)
    expect(h.url()).toBe('/?q=paris')
  })

  it('a slow move under two closes (New search over a pass and a photo) lands once', () => {
    const h = fakeHistory()
    const { s, open, uiClose, settle, endTick, elapse } = load(h)
    open('results')
    open('pass')
    open('lightbox')
    settle()
    uiClose('lightbox')
    uiClose('pass')
    endTick()
    expect(h.log.gos).toEqual([-2])
    h.holdApp()
    elapse(1500)
    h.releaseApp()
    settle()
    expect(h.log.gos).toEqual([-2])
    expect(s.names()).toEqual(['results'])
    expect(h.index()).toBe(1)
  })

  it('a slow move from a shallow stack never leaves the site', () => {
    const h = fakeHistory()
    const { s, open, uiClose, settle, endTick, elapse } = load(h)
    open('results')
    settle()
    uiClose('results')
    endTick()
    h.holdApp()
    elapse(1500)
    h.releaseApp()
    settle()
    expect(h.log.gos).toEqual([-1])
    expect(h.log.leftSite).toBe(0)
    expect(h.index()).toBe(0)
    expect(s.names()).toEqual([])
  })

  it('a slow move holds a later open only until the timeout; it lands, then Back closes the open layer', () => {
    const h = fakeHistory()
    const { s, open, uiClose, closed, settle, endTick, elapse } = load(h)
    open('results')
    open('pass')
    settle()
    uiClose('pass') // go(-1), slow
    endTick()
    h.holdApp()
    open('lightbox') // held behind it…
    settle()
    expect(h.length()).toBe(3)
    elapse(1000) // …until the timeout: it pushes
    h.releaseApp()
    settle()
    expect(h.log.gos).toEqual([-1])
    expect(h.log.leftSite).toBe(0)
    expect(s.names()).toEqual(['results', 'lightbox'])
    h.back()
    settle()
    expect(closed).toContain('lightbox')
    expect(s.names()).toEqual(['results'])
    expect(h.log.leftSite).toBe(0)
  })

  it('a dropped go() is not retried on time alone; later opens still go ahead and nothing leaves the site', () => {
    const h = fakeHistory()
    const { s, open, uiClose, settle, endTick, elapse } = load(h)
    open('results')
    settle()
    uiClose('results')
    endTick()
    h.dropApp()
    elapse(1500)
    expect(h.log.gos).toEqual([-1])
    open('results')
    settle()
    expect(s.names()).toEqual(['results'])
    expect(h.log.leftSite).toBe(0)
  })
  it('a second close while a slow move is on its way: both land, nothing is misread as the user’s (Esc, Esc)', () => {
    const h = fakeHistory()
    const { s, open, uiClose, closed, settle, endTick, elapse } = load(h)
    open('results')
    open('pass')
    settle()
    h.holdApp()
    uiClose('pass') // Esc: go(-1), slow
    endTick()
    uiClose('results') // Esc again: held behind it…
    settle()
    elapse(1000) // …until the timeout: its own go(-1)
    expect(h.log.gos).toEqual([-1, -1])
    h.releaseApp()
    settle()
    expect(h.log.gos).toEqual([-1, -1])
    expect(h.log.leftSite).toBe(0)
    expect(closed).toEqual([])
    expect(s.names()).toEqual([])
    expect(h.index()).toBe(0)
    expect(h.length()).toBe(3) // no entries put above a "user" move
    expect(h.url()).toBe('/')
  })
})

describe.each(MODELS)('races under the %s history model (CR-3)', (model) => {
  const setup = () => {
    const h = fakeHistory('/', { model })
    return { ...load(h), h }
  }

  it('a slow "All passes" closes one layer, issued once', () => {
    const { s, open, uiClose, settle, endTick, elapse, h } = setup()
    open('results')
    open('pass')
    settle()
    uiClose('pass')
    endTick()
    h.holdApp()
    elapse(1500)
    h.releaseApp()
    settle()
    expect(h.log.gos).toEqual([-1])
    expect(s.names()).toEqual(['results'])
    expect(h.url()).toBe('/?q=paris')
    expect(h.log.leftSite).toBe(0)
  })

  it('Esc, Esc with a slow first move: one move per close, never off the site', () => {
    const { s, open, uiClose, settle, endTick, elapse, h } = setup()
    open('results')
    open('pass')
    settle()
    h.holdApp()
    uiClose('pass')
    endTick()
    uiClose('results')
    settle()
    elapse(1000)
    h.releaseApp()
    settle()
    elapse(1000)
    expect(h.log.gos).toEqual([-1, -1])
    expect(s.names()).toEqual([])
    expect(h.log.leftSite).toBe(0)
    expect(h.length()).toBe(3)
    // 'callTime': the second move was aimed from the depth the stack believed (the first had not landed), at the same
    // entry; the browser stays one entry up: one dead Back at worst, never a close too many
    if (model !== 'callTime') expect(h.index()).toBe(0)
  })

  it('a user Back processed before the app’s go(-2): one round of entries at most, no second go(-2)', () => {
    const { s, open, uiClose, settle, appTasks, h } = setup()
    open('results')
    open('pass')
    settle()
    uiClose('pass')
    uiClose('results')
    appTasks()
    h.jumpFirst(-1)
    settle()
    expect(h.log.gos.filter((g) => g === -2)).toEqual([-2])
    expect(h.length()).toBeLessThanOrEqual(4)
    expect(s.names()).toEqual([])
    // 'queuedPush': the entries put above the user's apply after the app's move, which leaves from depth 1. Nothing
    // the app does after the user's Back can stop a move already queued; in the other two models it never leaves.
    if (model === 'queuedPush') expect(h.log.leftSite).toBe(1)
    else {
      expect(h.log.leftSite).toBe(0)
      expect(h.index()).toBe(0)
      expect(h.url()).toBe('/')
    }
  })

  it('a user Back first, then the app’s move dropped: the timeout reads the user’s depth and issues nothing (CR-2)', () => {
    const { s, open, uiClose, settle, appTasks, elapse, h } = setup()
    open('results')
    open('pass')
    settle()
    uiClose('pass')
    uiClose('results')
    appTasks()
    h.jumpFirst(-1)
    h.dropApp()
    settle()
    elapse(1500)
    expect(h.log.gos).toEqual([-2])
    expect(s.names()).toEqual([])
    expect(h.log.leftSite).toBe(0)
    expect(h.url()).toBe('/')
  })

  it('Forward into a dead entry then Back, before the undo: never off the site', () => {
    const { s, open, settle, endTick, h } = setup()
    open('results')
    settle()
    h.back()
    settle()
    h.forward()
    h.back()
    h.deliver()
    endTick()
    h.deliver()
    settle()
    expect(h.log.leftSite).toBe(0)
    expect(h.index()).toBe(0)
    expect(s.names()).toEqual([])
  })

  it('× then Back right after: the Back closes the pass', () => {
    const { s, open, uiClose, settle, endTick, h } = setup()
    open('results')
    open('pass')
    open('lightbox')
    settle()
    uiClose('lightbox')
    endTick()
    h.back()
    settle()
    expect(h.log.leftSite).toBe(0)
    // 'callTime': the user's Back was aimed at the entry the app's move was already going to, so it does nothing
    // (Chromium is not this model: probe (b) on a production build lands [2,1])
    expect(s.names()).toEqual(model === 'callTime' ? ['results', 'pass'] : ['results'])
  })
})
