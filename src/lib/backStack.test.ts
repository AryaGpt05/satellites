import { describe, expect, it } from 'vitest'
import { createBackStack, type HistoryLike } from './backStack'

/** A session history: entries + index; go() fires popstate (synchronously here) like a browser's Back. */
function fakeHistory() {
  const entries: { url: string }[] = [{ url: '/' }]
  let index = 0
  let onPop: (() => void) | null = null
  const h: HistoryLike & { back(): void; length: () => number; index: () => number; listen(fn: () => void): void; setUrl(u: string): void; url(): string } = {
    get state() {
      return null
    },
    pushState(_d, _u, url) {
      entries.splice(index + 1)
      entries.push({ url: url ?? entries[index].url })
      index++
    },
    replaceState(_d, _u, url) {
      if (url) entries[index].url = url
    },
    go(delta) {
      index = Math.max(0, Math.min(entries.length - 1, index + delta))
      onPop?.()
    },
    back() {
      this.go(-1)
    },
    length: () => entries.length,
    index: () => index,
    listen(fn) {
      onPop = fn
    },
    setUrl(u) {
      entries[index].url = u
    },
    url: () => entries[index].url,
  }
  return h
}

/** Microtask stand-in: run scheduled flushes when the test says the tick is over. */
function ticks() {
  const q: (() => void)[] = []
  return { schedule: (fn: () => void) => void q.push(fn), end: () => q.splice(0).forEach((f) => f()) }
}

function setup(adopt?: string) {
  const h = fakeHistory()
  const t = ticks()
  const s = createBackStack(h, t.schedule, adopt)
  h.listen(() => s.onPop())
  const closed: string[] = []
  const open = (name: string) => {
    const token = s.open(name, () => {
      closed.push(name)
      // The layer's own close: its React cleanup (or store subscription) reports it closed.
      s.closed(token)
    })
    return token
  }
  return { h, t, s, open, closed }
}

describe('back stack: Back closes the top layer, never leaves the site', () => {
  it('pushes one entry per layer and Back closes them top-down', () => {
    const { h, t, s, open, closed } = setup()
    open('results')
    t.end()
    open('pass')
    t.end()
    open('lightbox')
    t.end()
    expect(h.index()).toBe(3)
    h.back()
    expect(closed).toEqual(['lightbox'])
    t.end()
    expect(h.index()).toBe(2) // no extra history move for a close Back already did
    h.back()
    h.back()
    expect(closed).toEqual(['lightbox', 'pass', 'results'])
    expect(s.names()).toEqual([])
    expect(h.index()).toBe(0) // on the landing, still on the site
  })

  it('a close from the UI pops its own entry (no dead entries)', () => {
    const { h, t, s, open } = setup()
    open('results')
    t.end()
    const share = open('share')
    t.end()
    s.closed(share) // × on the share sheet
    t.end()
    expect(h.index()).toBe(1)
    expect(s.names()).toEqual(['results'])
  })

  it('layers closing together (New search over a pass and a photo) leave in one history move', () => {
    const { h, t, s, open } = setup()
    const results = open('results')
    const pass = open('pass')
    const lightbox = open('lightbox')
    t.end()
    expect(h.index()).toBe(3)
    let pops = 0
    h.listen(() => {
      pops++
      s.onPop()
    })
    // "New search": the store reset closes results and the pass; the viewer's cleanup reports after.
    s.closed(results)
    s.closed(pass)
    s.closed(lightbox)
    t.end()
    expect(h.index()).toBe(0)
    expect(pops).toBe(1)
    expect(s.names()).toEqual([])
  })

  it('a layer closing as another opens moves nothing (search mode → results keeps the address bar)', () => {
    const { h, t, s, open } = setup()
    const search = open('search')
    t.end()
    expect(h.index()).toBe(1)
    open('results')
    s.closed(search)
    h.setUrl('/?q=48.853,2.348&n=Paris') // the controller's replaceState
    t.end()
    expect(h.index()).toBe(1)
    expect(h.url()).toBe('/?q=48.853,2.348&n=Paris')
    expect(s.names()).toEqual(['results'])
  })

  it('a deep link adopts its boot entry, so Back lands on the landing entry under it', () => {
    const { h, t, s, open, closed } = setup('results')
    h.pushState(null, '', '/?q=1,2') // what backStack() does at boot: landing entry + the link's entry
    open('results')
    open('pass')
    t.end()
    expect(h.index()).toBe(2)
    h.back()
    h.back()
    expect(closed).toEqual(['pass', 'results'])
    expect(h.index()).toBe(0)
    expect(s.names()).toEqual([])
  })

  it('a Back with nothing open does nothing (the next one leaves)', () => {
    const { s } = setup()
    expect(s.onPop()).toBeUndefined()
  })
})
