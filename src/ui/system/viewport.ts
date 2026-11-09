/**
 * window.innerHeight for renders, cached. Reading innerHeight forces a synchronous style + layout in Chromium when
 * the page has pending layout work: a results render right after a big commit paid 114 ms of layout for it at 4×
 * CPU on a phone (U-1). Renders read this cache instead. It follows the window's and the visual viewport's resize
 * events (the address bar collapsing on a phone changes innerHeight), coalesced to one read per frame, so it is
 * never more than a frame behind.
 */
import { useSyncExternalStore } from 'react'

let vh = typeof window === 'undefined' ? 800 : window.innerHeight
const subs = new Set<() => void>()
let raf = 0

function onResize() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    const h = window.innerHeight
    if (h === vh) return
    vh = h
    subs.forEach((f) => f())
  })
}

// Listening from module load (not only while a component subscribes), so the cache is right whenever it is read.
if (typeof window !== 'undefined') {
  window.addEventListener('resize', onResize)
  window.visualViewport?.addEventListener('resize', onResize)
}

function subscribe(f: () => void) {
  subs.add(f)
  return () => void subs.delete(f)
}

/** The viewport height (px) as of the last frame: safe to read in a render. */
export const viewportHeight = (): number => vh

/** The viewport height (px), live: re-renders on a change (at most once per frame). */
export function useViewportHeight(): number {
  return useSyncExternalStore(subscribe, viewportHeight, () => 800)
}
