import { describe, expect, it } from 'vitest'
import { createBackStack, stampOf, type BackStack, type HistoryLike } from './backStack'

/**
 * A session history for one document: entries with their own state and URL, an index, and a popstate (fired
 * synchronously here) carrying the state of the entry moved to. `go` past either end does nothing, as in a browser
 * (and, below index 0, would have left the site: counted in `leftSite`).
 */
function fakeHistory(first = '/') {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: first }]
  let index = 0
  let onPop: ((state: unknown) => void) | null = null
  const log = { leftSite: 0, gos: [] as number[] }
  const h: HistoryLike & {
    back(): void
    forward(): void
    jump(delta: number): void
    index(): number
    length(): number
    listen(fn: (state: unknown) => void): void
    log: typeof log
    urlAt(i: number): string
  } = {
    get state() {
      return entries[index].state
    },
    url: () => entries[index].url,
    pushState(state, _u, url) {
      entries.splice(index + 1)
      entries.push({ state, url: url ?? entries[index].url })
      index++
    },
    replaceState(state, _u, url) {
      entries[index] = { state, url: url ?? entries[index].url }
    },
    go(delta) {
      log.gos.push(delta)
      if (index + delta < 0) log.leftSite++ // the APP moving off the site
      this.jump(delta)
    },
    jump(delta) {
      const to = index + delta
      if (to < 0) return // the first entry in the tab: a Back does nothing
      if (to >= entries.length || delta === 0) return
      index = to
      onPop?.(entries[index].state)
    },
    back() {
      this.jump(-1)
    },
    forward() {
      this.jump(1)
    },
    index: () => index,
    length: () => entries.length,
    listen(fn) {
      onPop = fn
    },
    log,
    urlAt: (i) => entries[i].url,
  }
  return h
}

/** Microtask stand-in: the batched move runs when the test ends the tick. */
function ticks() {
  const q: (() => void)[] = []
  return { schedule: (fn: () => void) => void q.push(fn), end: () => q.splice(0).forEach((f) => f()) }
}

/**
 * The app around the stack: layers that report their own closes, and an address-bar writer like Main's (?q=…&p=…)
 * that runs on store changes (BEFORE the stack's batched push, as zustand calls it) and on onSettled.
 */
function setup(opts: { first?: string; adopt?: string; slipIn?: boolean } = {}) {
  const h = fakeHistory(opts.first)
  const t = ticks()
  const app = { place: '' as string, pass: '' as string }
  const appUrl = () => (app.place ? `/?q=${app.place}${app.pass ? `&p=${app.pass}` : ''}` : '/')
  const writeUrl = () => h.replaceState(h.state, '', appUrl())
  let s: BackStack
  const closed: string[] = []
  const tokens = new Map<string, ReturnType<BackStack['open']>>()
  const closeLayer = (name: string) => {
    closed.push(name)
    if (name === 'pass') app.pass = ''
    if (name === 'results') app.place = ''
    writeUrl()
    s.closed(tokens.get(name)!)
  }
  s = createBackStack(h, { schedule: t.schedule, sid: 'load1', adopt: opts.adopt, slipIn: opts.slipIn, onSettled: writeUrl })
  h.listen((state) => s.onPop(state))
  const open = (name: string) => {
    if (name === 'results') app.place = app.place || 'paris'
    if (name === 'pass') app.pass = 'P1'
    if (name === 'results' || name === 'pass') writeUrl()
    tokens.set(name, s.open(name, () => closeLayer(name)))
  }
  /** A close from the UI (×, "All passes", "New search"): the app changes, then the layer reports it. */
  const uiClose = (name: string) => {
    if (name === 'pass') app.pass = ''
    if (name === 'results') app.place = ''
    writeUrl()
    s.closed(tokens.get(name)!)
  }
  return { h, t, s, open, uiClose, closed, app, appUrl }
}

describe('back stack: Back closes the top layer, never leaves the site', () => {
  it('one entry per layer; Back closes them top-down and stays on the site', () => {
    const { h, t, s, open, closed } = setup()
    open('results')
    t.end()
    open('pass')
    t.end()
    open('lightbox')
    t.end()
    expect(h.index()).toBe(3)
    h.back()
    h.back()
    h.back()
    expect(closed).toEqual(['lightbox', 'pass', 'results'])
    expect(s.names()).toEqual([])
    expect(h.index()).toBe(0)
    expect(h.log.leftSite).toBe(0)
  })

  it('a jump over several entries (long-press Back, go(-2)) closes every layer above it', () => {
    const { h, t, s, open, closed } = setup()
    open('results')
    open('pass')
    open('lightbox')
    t.end()
    h.jump(-2)
    expect(closed).toEqual(['lightbox', 'pass'])
    expect(s.names()).toEqual(['results'])
    h.back()
    expect(s.names()).toEqual([])
    expect(h.index()).toBe(0)
  })

  it('Forward never closes or reopens: a Forward into a closed layer is undone (H1)', () => {
    const { h, t, s, open, closed, appUrl } = setup()
    open('results')
    t.end()
    open('pass')
    t.end()
    h.back() // closes the pass
    expect(s.names()).toEqual(['results'])
    h.forward() // into the pass's old entry
    expect(closed).toEqual(['pass'])
    expect(s.names()).toEqual(['results'])
    expect(h.index()).toBe(1) // bounced back to where the app is
    expect(h.url()).toBe(appUrl())
    // and the history still works: Back now closes the results
    h.back()
    expect(s.names()).toEqual([])
    expect(h.url()).toBe('/')
  })

  it('Forward after Back from a deep link never shows the landing under a ?q= address (H1, repro A)', () => {
    const { h, t, s, open } = setup({ first: '/?q=waterloo', adopt: 'results', slipIn: true })
    open('results')
    t.end()
    h.back()
    expect(s.names()).toEqual([])
    expect(h.url()).toBe('/')
    h.forward()
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
  })

  it('a pass closed from the UI leaves the address bar on the list, not on the pass (H2)', () => {
    const { h, t, open, uiClose, appUrl } = setup()
    open('results')
    t.end()
    open('pass') // the ?p= writer runs before the push, as in the app
    t.end()
    expect(h.url()).toBe('/?q=paris&p=P1')
    uiClose('pass') // "All passes"
    t.end()
    expect(h.index()).toBe(1)
    expect(h.url()).toBe(appUrl())
    expect(h.url()).toBe('/?q=paris')
    // a later Back still lands on the landing with its own address
    h.back()
    expect(h.url()).toBe('/')
  })

  it('layers closing together (New search over a pass and a photo) leave in one move, address correct', () => {
    const { h, t, s, open, uiClose } = setup()
    open('results')
    open('pass')
    open('lightbox')
    t.end()
    uiClose('lightbox')
    uiClose('pass')
    uiClose('results')
    t.end()
    expect(h.log.gos).toEqual([-3])
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
    expect(s.names()).toEqual([])
  })

  it('a layer closing as another opens moves nothing (search mode → results keeps the address bar)', () => {
    const { h, t, s, open, uiClose } = setup()
    open('search')
    t.end()
    open('results')
    uiClose('search')
    t.end()
    expect(h.index()).toBe(1)
    expect(h.url()).toBe('/?q=paris')
    expect(s.names()).toEqual(['results'])
  })

  it('a deep link adopts its entry over a slipped-in landing: Back lands on the landing', () => {
    const { h, t, open, closed } = setup({ first: '/?q=paris', adopt: 'results', slipIn: true })
    open('results')
    open('pass')
    t.end()
    expect(h.index()).toBe(2)
    expect(h.urlAt(0)).toBe('/')
    h.back()
    h.back()
    expect(closed).toEqual(['pass', 'results'])
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
  })

  it('a Back during a deep link’s boot (before the results open) never desyncs it (H3)', () => {
    // First entry in the tab (Reddit's in-app browser): the Back does nothing; the results then open over a landing.
    const { h, t, s, open, uiClose } = setup({ first: '/?q=paris', adopt: 'results', slipIn: true })
    h.back()
    expect(h.index()).toBe(0)
    open('results')
    t.end()
    expect(h.index()).toBe(1)
    // CANCEL while computing (a close from the UI): back to the landing entry, never off the site.
    uiClose('results')
    t.end()
    expect(h.index()).toBe(0)
    expect(h.url()).toBe('/')
    expect(h.log.leftSite).toBe(0)
    expect(s.names()).toEqual([])
  })

  it('a deep link that never opens results (an expired share) slips nothing in (H6)', () => {
    const { h, t, open } = setup({ first: '/?s=expired', adopt: 'results', slipIn: true })
    open('search') // the landing's search mode: not the deep link's results
    t.end()
    expect(h.length()).toBe(2)
    expect(h.urlAt(0)).toBe('/?s=expired')
  })

  it('a reload adds no landing entry, and the app’s own closes never leave the site (H5)', () => {
    const { h, t, s, open, uiClose } = setup({ first: '/?q=paris', adopt: 'results', slipIn: false })
    open('results')
    t.end()
    expect(h.length()).toBe(1)
    open('pass')
    t.end()
    h.back() // closes the pass
    expect(s.names()).toEqual(['results'])
    uiClose('results') // New search: the results held no entry, nothing to take off
    t.end()
    expect(h.log.leftSite).toBe(0)
    expect(h.log.gos.every((n) => n >= -1)).toBe(true)
  })

  it('stamps every entry with this load and its depth; another load’s stamps read as depth 0', () => {
    const { h, t, open } = setup()
    open('results')
    t.end()
    expect(stampOf(h.state, 'load1')).toEqual({ s: 'load1', d: 1 })
    expect(stampOf(h.state, 'load2')).toBeUndefined()
  })
})
