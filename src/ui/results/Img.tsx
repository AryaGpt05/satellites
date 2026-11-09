/**
 * <Img/>: a decoded photo shown through the view's own session element (images.ts photoElement, R3-1).
 *
 * React renders an empty `display: contents` host; the element is attached in a layout effect (before the first
 * paint), so a remount re-attaches the very element shown before: no request, no decode, no load event, no fade.
 * `fadeClass` (a one-time entrance) is applied only on the mount that first shows the photo and removed when its
 * animation ends, so moving the element later (a keyed list reordering it) never replays it.
 *
 * A photo not decoded yet is loaded through the shared loader (a cache hit for anything the archives' probes or the
 * hero preload already fetched) and attached when it is; `onError` reports a failure.
 */
import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import { loadPhoto, photoElement, type PhotoView } from './images'

const HOST: CSSProperties = { display: 'contents' }

export interface ImgProps {
  view: PhotoView
  url: string
  alt: string
  className?: string
  /** One-time entrance class (removed at its animationend) */
  fadeClass?: string
  ariaHidden?: boolean
  onReady?: () => void
  onError?: () => void
}

export function Img({ view, url, alt, className, fadeClass, ariaHidden, onReady, onError }: ImgProps) {
  const host = useRef<HTMLSpanElement>(null)
  const cb = useRef({ onReady, onError })
  cb.current = { onReady, onError }
  const fade = useRef(fadeClass)
  fade.current = fadeClass
  const cls = useRef(className)
  cls.current = className
  const label = useRef({ alt, ariaHidden })
  label.current = { alt, ariaHidden }

  useLayoutEffect(() => {
    const h = host.current
    if (!h) return
    let alive = true
    const attach = (el: HTMLImageElement) => {
      if (!alive) return
      const f = fade.current
      el.className = [cls.current, f].filter(Boolean).join(' ')
      if (f) {
        const done = (e: AnimationEvent) => {
          if (e.target !== el) return
          el.classList.remove(f)
          el.removeEventListener('animationend', done)
          el.removeEventListener('animationcancel', done)
        }
        el.addEventListener('animationend', done)
        el.addEventListener('animationcancel', done)
      }
      el.alt = label.current.alt
      if (label.current.ariaHidden) el.setAttribute('aria-hidden', 'true')
      else el.removeAttribute('aria-hidden')
      if (el.parentNode !== h) h.replaceChildren(el)
      cb.current.onReady?.()
    }
    const el = photoElement(view, url)
    if (el) attach(el)
    else
      loadPhoto(url)
        .then(() => {
          const e2 = photoElement(view, url)
          if (e2) attach(e2)
        })
        .catch(() => alive && cb.current.onError?.())
    return () => {
      alive = false
    }
  }, [view, url])

  // Later class changes (a dim level) apply in place; never the fade.
  useLayoutEffect(() => {
    const el = host.current?.firstElementChild as HTMLImageElement | null
    if (!el) return
    const keepFade = fade.current && el.classList.contains(fade.current)
    el.className = [className, keepFade ? fade.current : undefined].filter(Boolean).join(' ')
  }, [className])

  useLayoutEffect(() => {
    const el = host.current?.firstElementChild as HTMLImageElement | null
    if (!el) return
    el.alt = alt
    if (ariaHidden) el.setAttribute('aria-hidden', 'true')
    else el.removeAttribute('aria-hidden')
  })

  return <span ref={host} style={HOST} />
}
