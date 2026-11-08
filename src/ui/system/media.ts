/**
 * Media-query hooks shared by the UI. The breakpoint mirrors the `@media (max-width: 760px)` block in
 * src/styles/tokens.css — keep them in sync.
 */
import { useSyncExternalStore } from 'react'

/** Phone layout: bottom sheets, condensed corner readouts, stacked hero. */
import { STACKED_QUERY } from '@/lib/layout'
/** Stacked (phone-like) layout: see src/lib/layout.ts */
export const MOBILE_QUERY = STACKED_QUERY
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeTo(query: string) {
  return (onChange: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => undefined
    const mql = window.matchMedia(query)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }
}

const subscribers = new Map<string, (onChange: () => void) => () => void>()

/** Live boolean for a media query. SSR / no-matchMedia environments read `false`. */
export function useMediaQuery(query: string): boolean {
  let subscribe = subscribers.get(query)
  if (!subscribe) {
    subscribe = subscribeTo(query)
    subscribers.set(query, subscribe)
  }
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  )
}

export const useIsMobile = () => useMediaQuery(MOBILE_QUERY)
export const useReducedMotion = () => useMediaQuery(REDUCED_MOTION_QUERY)
