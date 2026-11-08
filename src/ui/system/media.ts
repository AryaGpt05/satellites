/**
 * Media-query hooks shared by the UI. "Mobile" means the stacked layout (phones and portrait tablets):
 * see src/lib/layout.ts, which stylesheets copy by hand.
 */
import { useSyncExternalStore } from 'react'
import { STACKED_QUERY } from '@/lib/layout'

/** Stacked (phone-like) layout: bottom sheets, condensed corner readouts, the globe above the copy. */
export const MOBILE_QUERY = STACKED_QUERY
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** One MediaQueryList per query: reading `.matches` on it is cheap; creating one per render is not. */
const lists = new Map<string, MediaQueryList>()
function list(query: string): MediaQueryList | undefined {
  if (typeof window === 'undefined' || !window.matchMedia) return undefined
  let mql = lists.get(query)
  if (!mql) {
    mql = window.matchMedia(query)
    lists.set(query, mql)
  }
  return mql
}

const subscribers = new Map<string, (onChange: () => void) => () => void>()
function subscriberFor(query: string) {
  let subscribe = subscribers.get(query)
  if (!subscribe) {
    subscribe = (onChange: () => void) => {
      const mql = list(query)
      if (!mql) return () => undefined
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    subscribers.set(query, subscribe)
  }
  return subscribe
}

/** Live boolean for a media query. SSR / no-matchMedia environments read `false`. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscriberFor(query),
    () => list(query)?.matches ?? false,
    () => false,
  )
}

export const useIsMobile = () => useMediaQuery(MOBILE_QUERY)
export const useReducedMotion = () => useMediaQuery(REDUCED_MOTION_QUERY)
