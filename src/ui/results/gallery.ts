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
}

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
  openLightbox: (key, from) => set({ lightbox: { key, from } }),
  closeLightbox: () => set({ lightbox: null }),
}))
