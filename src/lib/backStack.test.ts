import { describe, expect, it } from 'vitest'
import { createBackStack, resolveTabId, stampOf, type BackStack, type HistoryLike } from './backStack'

/**
 * A session history for one tab, asynchronous like a browser's: `go` picks its target entry when called and lands it
 * (with a popstate carrying that entry's state) in a later task, `deliver()`. A pushState in between lands as browsers
 * do: the traversal still goes to the entry it picked. Moving below the first entry would leave the site: counted
 * when the APP does it (`leftSite`); a user Back there does nothing (first entry in the tab).
 */
function fakeHistory(first = '/') {
  type Entry = { state: unknown; url: string }
  const entries: Entry[] = [{ state: null, url: first }]
  let index = 0
  let onPop: ((state: unknown) => void) | null = null
  const pending: Entry[] = []
  const log = { leftSite: 0, gos: [] as number[], pops: 0 }
  const traverse = (delta: number, byApp: boolean) => {
    const to = index + delta
    if (to < 0) {
      if (byApp) log.leftSite++
      return
    }
    if (to >= entries.length || delta === 0) return
    pending.push(entries[to])
  }
  const h = {
    get state() {
      return entries[index].state
    },
    url: () => entries[index].url,
    pushState(state: unknown, _u: string, url?: string | null) {
      entries.splice(index + 1)
      entries.push({ state, url: url ?? entries[index].url })
      index++
    },
    replaceState(state: unknown, _u: string, url?: string | null) {
      entries[index] = { state, url: url ?? entries[index].url }
    },
    go(delta: number) {
      log.gos.push(delta)
      traverse(delta, true)
    },
    /** The user's Back / Forward / long-press jump */
    jump: (delta: number) => traverse(delta, false),
    back: () => traverse(-1, false),
    forward: () => traverse(1, false),
    /** Land the traversals in flight (a later task). */
    deliver() {
      let moved = false
      while (pending.length) {
        const target = pending.shift()!
        const i = entries.indexOf(target)
        if (i < 0) continue
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
  const app = { place: opts.place ?? '', pass: opts.pass ?? '' }
  const appUrl = () => (app.place ? `/?q=${app.place}${app.pass ? `&p=${app.pass}` : ''}` : '/')
  const writeUrl = () => h.replaceState(h.state, '', appUrl())
  const closed: string[] = []
  const tokens = new Map<string, ReturnType<BackStack['open']>>()
  const s: BackStack = createBackStack(h, {
    schedule: (fn) => void micro.push(fn),
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
  /** Run microtasks and deliver traversals until nothing is left (the tick and the tasks after it). */
  const settle = () => {
    for (let i = 0; i < 20; i++) {
      const ran = micro.length > 0
      micro.splice(0).forEach((f) => f())
      if (!h.deliver() && !ran && micro.length === 0) return
    }
  }
  return { s, open, uiClose, closed, app, appUrl, settle, endTick: () => micro.splice(0).forEach((f) => f()) }
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
