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

/**
 * The top safe-area inset (px): a notch / status bar over a home-screen web app, or a landscape notch's top. Read
 * from a fixed probe's computed padding (a style read, no layout), at load and after each resize (a rotation changes
 * it). PH-09: the sheet's top snap and the landing's lifted search keep the HUD band below it clear.
 */
let safeTop = 0
let probe: HTMLElement | null = null
function readSafeTop(): number {
  if (typeof document === 'undefined') return 0
  if (!probe) {
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) 0 env(safe-area-inset-left,0px)'
    document.documentElement.appendChild(probe)
  }
  const cs = getComputedStyle(probe)
  sides = { left: Number.parseFloat(cs.paddingLeft) || 0, right: Number.parseFloat(cs.paddingRight) || 0 }
  return Number.parseFloat(cs.paddingTop) || 0
}
/** The side safe-area insets (a landscape notch and the rounded corners), read with the top one. */
let sides = { left: 0, right: 0 }

function onResize() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    const h = window.innerHeight
    const top = readSafeTop()
    if (h === vh && top === safeTop) return
    vh = h
    safeTop = top
    subs.forEach((f) => f())
  })
}

// Listening from module load (not only while a component subscribes), so the cache is right whenever it is read.
if (typeof window !== 'undefined') {
  safeTop = readSafeTop()
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

/** The top safe-area inset (px) as of the last frame: safe to read in a render (changes re-render useViewportHeight users). */
export const safeAreaTop = (): number => safeTop

/** The left / right safe-area insets (px) as of the last frame (a landscape notch and the rounded corners). */
export const safeAreaSides = (): { left: number; right: number } => sides
