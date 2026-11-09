/**
 * Gallery state shared by the summary hero, the pass view and the lightbox (owner B): which photo is current,
 * the filter, and whether the lightbox is open. A tiny store of its own, so a swipe re-renders the gallery
 * and nothing else (never the whole results view).
 */
import { create } from 'zustand'
import type { PhotoFilter } from './lib/photos'

export interface LightboxState {
  /** Photo key shown first */
  key: string
  /** The element the photo grows from (and shrinks back to, if it is still the current one) */
  from: HTMLElement | null
  /** One per opening: a viewer still shrinking away never closes the one opened after it */
  id: number
}
let opened = 0

interface GalleryState {
  /** The report these belong to (a new report resets them) */
  reportKey: string
  filter: PhotoFilter
  /** Current photo (undefined: the cover) */
  key?: string
  /** The user moved the gallery: the cover may no longer move it (partial → final) */
  touched: boolean
  lightbox: LightboxState | null
  reset: (reportKey: string) => void
  setFilter: (f: PhotoFilter) => void
  setKey: (key: string | undefined, touched?: boolean) => void
  openLightbox: (key: string, from: HTMLElement | null) => void
  closeLightbox: () => void
}

export const useGallery = create<GalleryState>((set) => ({
  reportKey: '',
  filter: 'all',
  key: undefined,
  touched: false,
  lightbox: null,
  reset: (reportKey) => set((st) => (st.reportKey === reportKey ? {} : { reportKey, filter: 'all', key: undefined, touched: false, lightbox: null })),
  setFilter: (filter) => set({ filter, touched: true }),
  setKey: (key, touched = true) => set((st) => (st.key === key && (!touched || st.touched) ? {} : { key, touched: st.touched || touched })),
  openLightbox: (key, from) => set({ lightbox: { key, from, id: ++opened } }),
  closeLightbox: () => set({ lightbox: null }),
}))

// ── the cover, chosen once (owner R-M1) ──────────────────────────────────────────────────────

/**
 * Owner R-M1 (phones, P0: "choose the cover once … then never swap to a different photo without a user action"):
 * the photo the summary's hero first painted stays photo #1 for that report (place + window). A better cover that
 * lands later (the last clear look from a background patch, a spot check settling) takes the next place, right
 * after it (on phones it peeks at the right edge), instead of replacing the picture on screen. The hero, the pass
 * view's gallery and the lightbox all use this one order.
 */
const pinned = new Map<string, string>()
const MAX_PINS = 24

/** The report a pin belongs to: its place and window (a new search is a new window, a new pin). */
export const coverPinKey = (r: { windowEnd: number; place: { lat: number; lon: number } }) => `${r.windowEnd}:${r.place.lat},${r.place.lon}`

/** Record the photo the hero painted first for this report (only the first call per report counts). */
export function pinCover(reportKey: string, photoKey: string | undefined): void {
  if (!photoKey || pinned.has(reportKey)) return
  pinned.set(reportKey, photoKey)
  if (pinned.size > MAX_PINS) pinned.delete(pinned.keys().next().value as string)
}

/** `photos` (cover first, then newest first) with the pinned photo kept first, when it is still there. */
export function pinnedOrder<T extends { key: string }>(photos: T[], reportKey: string): T[] {
  const pin = pinned.get(reportKey)
  if (!pin || !photos.length || photos[0].key === pin) return photos
  const i = photos.findIndex((p) => p.key === pin)
  if (i < 0) return photos
  return [photos[i], ...photos.slice(0, i), ...photos.slice(i + 1)]
}
