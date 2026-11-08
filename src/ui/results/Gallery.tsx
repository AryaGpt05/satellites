/**
 * THE gallery (owner B): one carousel for every place a photo appears in the panel, the summary hero
 * ('hero') and the pass view ('detail'), so you can start swiping from the hero.
 *
 *   phones   full-width cards with the next one peeking ~12 % at the right; native horizontal scroll with
 *            CSS scroll-snap (x mandatory), momentum, overscroll contained (the sheet and page never move).
 *   laptops  one card at the column's width, ‹ › buttons, ← → keys, trackpad horizontal scroll.
 *   both     a filter (All · Detailed · Weather), a counter ("3 / 27"), a slim progress rail, and an expand
 *            control (F) that opens the lightbox.
 *
 * Order: lib/photos.ts (the closest clear look, then newest first). Swiping in the pass view selects the
 * photo's pass QUIETLY, 250 ms after the scroll settles (no replay, no new reveal; rapid swipes never queue
 * camera flights). In the summary a swipe only moves the gallery; "Replay this pass" opens the pass.
 *
 * Cheap while scrolling: the counter and the rail are written through refs from a rAF-throttled scroll
 * listener (no layout reads: the stride comes from a ResizeObserver); React renders only when the photo
 * under the snap changes (which neighbours load) and when it settles.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Pass } from '@/types'
import { Glyph, cx, prefersReducedMotion } from '@/ui/system'
import { Ago } from './Ago'
import { Mark } from './Mark'
import { PhotoFrame, coordsOf } from './PhotoFrame'
import { selectQuietly } from './actions'
import { useGallery } from './gallery'
import { warmPhoto } from './images'
import { filterCounts, filterPhotos, cardUrl, cropWidthKm, type Photo, type PhotoFilter } from './lib/photos'
import { productLabel } from './lib/captures'
import { dec1, int } from './lib/copy'
import { fmtLocalDay, fmtLocalTime, zoneAbbr } from './lib/time'
import type { ResultsModel } from './model'
import s from './Gallery.module.css'

/** Imperative handle for the keyboard (← → and F) while a gallery is mounted. */
export const galleryCtl: { current: null | { step: (dir: 1 | -1) => boolean; expand: () => boolean; jump: (key: string) => boolean } } = { current: null }

const SETTLE_MS = 140
const SELECT_DEBOUNCE_MS = 250
const NEAR = 2

export interface GalleryProps {
  model: ResultsModel
  context: 'hero' | 'detail'
  mobile: boolean
  /** The pass the pass view shows (detail): the gallery follows it */
  selectedId?: string
  /** Hero: open the photo's pass with its replay. Detail: replay the current pass. */
  onReplay?: (pass: Pass) => void
  onShare?: (pass: Pass) => void
}

export function Gallery({ model, context, mobile, selectedId, onReplay, onShare }: GalleryProps) {
  const filter = useGallery((g) => g.filter)
  const storeKey = useGallery((g) => g.key)
  const touched = useGallery((g) => g.touched)
  const detail = context === 'detail'
  // The pass view only shows photos that have a pass (the clear cover from before the window has none).
  const all = useMemo(() => (detail ? model.photos.filter((p) => !!p.pass) : model.photos), [model.photos, detail])
  const counts = useMemo(() => filterCounts(all), [all])
  const items = useMemo(() => filterPhotos(all, filter), [all, filter])
  const selectedKey = detail && selectedId ? model.photoByPass.get(selectedId) : undefined

  // A selected photo the filter hides: show everything again.
  useEffect(() => {
    if (selectedKey && !items.some((p) => p.key === selectedKey)) useGallery.setState({ filter: 'all' })
  }, [selectedKey, items])

  // Untouched, the summary shows the cover (photo #1); once the user has moved it, the photo they left it on.
  const wantKey = selectedKey ?? (touched ? storeKey : undefined) ?? model.cover?.photo.key
  const wantIdx = Math.max(0, items.findIndex((p) => p.key === wantKey))
  const [idx, setIdx] = useState(wantIdx)
  const idxRef = useRef(idx)
  idxRef.current = idx

  const trackRef = useRef<HTMLDivElement>(null)
  const counterRef = useRef<HTMLSpanElement>(null)
  const railRef = useRef<HTMLSpanElement>(null)
  const geo = useRef({ stride: 0, railW: 0, ready: false })
  /** A programmatic scroll in flight: settle commits it without a feedback loop */
  const target = useRef<number | null>(null)
  const selectTimer = useRef(0)

  const n = items.length
  const windowItems = useMemo(() => items.filter((p) => !!p.pass), [items])
  const counterText = useCallback(
    (i: number) => {
      const p = items[i]
      if (!p) return ''
      if (!p.pass) return `— / ${windowItems.length}`
      return `${windowItems.indexOf(p) + 1} / ${windowItems.length}`
    },
    [items, windowItems],
  )

  const paintChrome = useCallback(
    (pos: number) => {
      const c = counterRef.current
      const i = Math.min(n - 1, Math.max(0, Math.round(pos)))
      const text = counterText(i)
      if (c && c.textContent !== text) c.textContent = text
      const r = railRef.current
      const g = geo.current
      if (r && g.railW && n > 1) {
        const w = Math.max(8, g.railW / n)
        r.style.width = `${w}px`
        r.style.transform = `translateX(${((g.railW - w) * Math.min(1, Math.max(0, pos / (n - 1)))).toFixed(1)}px)`
      }
    },
    [n, counterText],
  )

  // Geometry from a ResizeObserver (after layout: no forced layout in the commit); the first callback also
  // puts the track on the current photo before the first paint.
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const a = track.children[0] as HTMLElement | undefined
      const b = track.children[1] as HTMLElement | undefined
      geo.current.stride = a ? (b ? b.offsetLeft - a.offsetLeft : a.offsetWidth) : 0
      geo.current.railW = railRef.current?.parentElement?.clientWidth ?? 0
      const first = !geo.current.ready
      geo.current.ready = true
      if (first || target.current === null) {
        const left = idxRef.current * geo.current.stride
        if (Math.abs(track.scrollLeft - left) > 1) track.scrollLeft = left
      }
      paintChrome(idxRef.current)
    })
    ro.observe(track)
    return () => ro.disconnect()
  }, [paintChrome])

  /** performance.now() of the last user input on the gallery (a scroll the browser makes on its own, a re-snap after
   * a layout change, is not the user's: it never selects a pass or marks the gallery touched) */
  const userAt = useRef(-Infinity)
  const goTo = useCallback(
    (i: number, smooth = true, user = true) => {
      const track = trackRef.current
      const k = Math.min(n - 1, Math.max(0, i))
      if (!track || !geo.current.stride) return
      if (user) userAt.current = performance.now()
      target.current = k
      const left = k * geo.current.stride
      if (Math.abs(track.scrollLeft - left) < 1) return settleRef.current()
      track.scrollTo({ left, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' })
      if (!smooth) settleRef.current()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [n],
  )

  /** The scroll came to rest on a photo: commit it (store), and in the pass view select its pass quietly. */
  const settle = () => {
    const track = trackRef.current
    const g = geo.current
    if (!track || !g.stride) return
    const i = Math.min(n - 1, Math.max(0, Math.round(track.scrollLeft / g.stride)))
    target.current = null
    if (i !== idxRef.current) setIdx(i)
    paintChrome(i)
    const p = items[i]
    if (!p) return
    const user = performance.now() - userAt.current < 2500
    useGallery.getState().setKey(p.key, user)
    window.clearTimeout(selectTimer.current)
    if (user && detail && p.pass && p.pass.id !== selectedId) {
      const pass = p.pass
      selectTimer.current = window.setTimeout(() => {
        const t = trackRef.current
        // Still there after the debounce: select it (never a queue of flights for a fast flick).
        if (t && Math.round(t.scrollLeft / geo.current.stride) === i) selectQuietly(pass)
      }, SELECT_DEBOUNCE_MS)
    }
  }
  const settleRef = useRef(settle)
  settleRef.current = settle

  // Scroll: chrome per frame (refs), the neighbour window when the photo under the snap changes, settle at rest.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    let raf = 0
    let timer = 0
    const onScroll = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          const g = geo.current
          if (!g.stride) return
          const pos = track.scrollLeft / g.stride
          paintChrome(pos)
          const i = Math.round(pos)
          if (i !== idxRef.current && i >= 0 && i < n) setIdx(i)
        })
      window.clearTimeout(timer)
      timer = window.setTimeout(() => settleRef.current(), SETTLE_MS)
    }
    const onEnd = () => {
      window.clearTimeout(timer)
      settleRef.current()
    }
    const onInput = () => (userAt.current = performance.now())
    track.addEventListener('scroll', onScroll, { passive: true })
    track.addEventListener('scrollend', onEnd)
    track.addEventListener('pointerdown', onInput, { passive: true })
    track.addEventListener('touchstart', onInput, { passive: true })
    track.addEventListener('wheel', onInput, { passive: true })
    return () => {
      track.removeEventListener('scroll', onScroll)
      track.removeEventListener('scrollend', onEnd)
      track.removeEventListener('pointerdown', onInput)
      track.removeEventListener('touchstart', onInput)
      track.removeEventListener('wheel', onInput)
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      window.clearTimeout(selectTimer.current)
    }
  }, [n, paintChrome])

  // The selection (or the filter) moved elsewhere (timeline, list, header, the lightbox): follow it. A new
  // filter jumps (the list changed under the photo); a nearby photo glides there.
  const lastFilter = useRef(filter)
  useEffect(() => {
    const filterChanged = lastFilter.current !== filter
    lastFilter.current = filter
    if (!filterChanged && wantIdx === idxRef.current && target.current === null) return
    if (!filterChanged && target.current === wantIdx) return
    setIdx(wantIdx)
    if (!geo.current.ready) return
    goTo(wantIdx, !filterChanged && Math.abs(wantIdx - idxRef.current) <= 3, filterChanged)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantIdx, filter])

  // The cover changed under an untouched summary gallery (the last clear look arrived after the first paint,
  // owner D): cross-fade to it in place: the old picture fades out over the new one; nothing scrolls.
  const coverKey = model.cover?.photo.key
  const prevCover = useRef(coverKey)
  useLayoutEffect(() => {
    const prev = prevCover.current
    prevCover.current = coverKey
    const track = trackRef.current
    if (detail || !prev || !coverKey || prev === coverKey || !track || useGallery.getState().touched) return
    const viewport = track.parentElement
    const old = track.querySelector<HTMLElement>(`[data-photo-frame="${CSS.escape(prev)}"]`)
    const first = track.children[0] as HTMLElement | undefined
    if (viewport && old && first && typeof old.animate === 'function' && !prefersReducedMotion()) {
      const ghost = old.cloneNode(true) as HTMLElement
      ghost.setAttribute('aria-hidden', 'true')
      ghost.inert = true
      Object.assign(ghost.style, { position: 'absolute', left: '0px', top: `${first.offsetTop}px`, width: `${old.offsetWidth}px`, height: `${old.offsetHeight}px`, pointerEvents: 'none', zIndex: '1' })
      viewport.appendChild(ghost)
      const a = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'linear', fill: 'forwards' })
      a.onfinish = a.oncancel = () => ghost.remove()
    }
    target.current = null
    track.scrollLeft = 0
    idxRef.current = 0
    setIdx(0)
    paintChrome(0)
    useGallery.getState().setKey(coverKey, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverKey])

  // Preload ±2 (decoded before they are swiped to).
  useEffect(() => {
    for (let d = -NEAR; d <= NEAR; d++) {
      const p = items[idx + d]
      if (p && d !== 0) warmPhoto(cardUrl(p.capture))
    }
  }, [idx, items])

  const open = useCallback(
    (p: Photo, el: HTMLElement) => useGallery.getState().openLightbox(p.key, el),
    [],
  )

  // Keyboard handle (← → step, F expands).
  useEffect(() => {
    galleryCtl.current = {
      step: (dir) => {
        const i = (target.current ?? idxRef.current) + dir
        if (i < 0 || i >= n) return false
        goTo(i)
        return true
      },
      jump: (key) => {
        const i = items.findIndex((p) => p.key === key)
        const track = trackRef.current
        if (i < 0 || !track || !geo.current.stride) return false
        target.current = null
        track.scrollLeft = i * geo.current.stride
        setIdx(i)
        paintChrome(i)
        return true
      },
      expand: () => {
        const p = items[target.current ?? idxRef.current]
        const el = p ? trackRef.current?.querySelector<HTMLElement>(`[data-photo-frame="${CSS.escape(p.key)}"]`) : null
        if (!p || !el) return false
        open(p, el)
        return true
      },
    }
    return () => {
      galleryCtl.current = null
    }
  }, [n, items, goTo, open, paintChrome])

  if (!n) return null
  const showFilter = counts.detailed > 0 && counts.weather > 0
  const hero = !detail

  return (
    <div className={cx(s.gallery, hero ? s.hero : s.detail, mobile && s.mobile)} data-gallery={context}>
      <div className={s.bar}>
        {showFilter ? <FilterControl filter={filter} counts={counts} /> : <span className={s.barLabel}>{hero ? 'Photos' : null}</span>}
        <span className={s.nav}>
          <span ref={counterRef} className={s.counter} aria-live="polite" aria-atomic="true">
            {counterText(idx)}
          </span>
          {!mobile ? (
            <>
              <button type="button" className={s.navBtn} onClick={() => goTo(idx - 1)} disabled={idx <= 0} aria-label="Previous photo" aria-keyshortcuts="ArrowLeft" title="Previous (←)">
                <Mark name="chevron-left" size={12} />
              </button>
              <button type="button" className={s.navBtn} onClick={() => goTo(idx + 1)} disabled={idx >= n - 1} aria-label="Next photo" aria-keyshortcuts="ArrowRight" title="Next (→)">
                <Mark name="chevron-right" size={12} />
              </button>
            </>
          ) : null}
        </span>
      </div>

      <div className={s.viewport}>
        <div ref={trackRef} className={s.track} role="group" aria-roledescription="carousel" aria-label="Photos of this place, swipe for more">
          {items.map((p, i) => (
            <Slide
              key={p.key}
              photo={p}
              model={model}
              context={context}
              mobile={mobile}
              index={i}
              total={n}
              near={Math.abs(i - idx) <= NEAR}
              current={i === idx}
              cover={model.cover?.photo.key === p.key ? model.cover.why : undefined}
              selected={detail && p.pass?.id === selectedId}
              onExpand={open}
              onReplay={hero ? onReplay : undefined}
              onShare={hero ? onShare : undefined}
            />
          ))}
        </div>
        {n > 1 ? (
          <span className={s.rail} aria-hidden>
            <span ref={railRef} className={s.railThumb} />
          </span>
        ) : null}
      </div>

    </div>
  )
}

/** All · Detailed · Weather: a hairline segmented control (owner B2). */
function FilterControl({ filter, counts }: { filter: PhotoFilter; counts: Record<PhotoFilter, number> }) {
  const opts: { f: PhotoFilter; label: string; title: string }[] = [
    { f: 'all', label: 'All', title: 'Every photo, newest first after the closest look' },
    { f: 'detailed', label: 'Detailed', title: 'Sentinel-2 and Landsat, 10–30 m per pixel' },
    { f: 'weather', label: 'Weather', title: 'Daily weather mosaics, 250 m per pixel and coarser' },
  ]
  return (
    <span className={s.filter} role="group" aria-label="Show photos">
      {opts.map((o) => (
        <button
          key={o.f}
          type="button"
          className={cx(s.seg, filter === o.f && s.segOn)}
          aria-pressed={filter === o.f}
          disabled={!counts[o.f]}
          title={o.title}
          onClick={() => useGallery.getState().setFilter(o.f)}
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}

interface SlideProps {
  photo: Photo
  model: ResultsModel
  context: 'hero' | 'detail'
  mobile: boolean
  index: number
  total: number
  near: boolean
  current: boolean
  cover?: 'closest' | 'lastClear' | 'clouded'
  selected: boolean
  onExpand: (p: Photo, el: HTMLElement) => void
  onReplay?: (pass: Pass) => void
  onShare?: (pass: Pass) => void
}

const Slide = memo(function Slide({ photo, model, context, mobile, index, total, near, current, cover, selected, onExpand, onReplay, onShare }: SlideProps) {
  const detail = context === 'detail'
  const { capture, pass } = photo
  const meta = model.meta(pass?.norad ?? capture.norad ?? 0)
  const tz = model.tz
  const t = pass ? model.times(pass) : { day: fmtLocalDay(capture.datetime, tz), time: fmtLocalTime(capture.datetime, tz), zone: zoneAbbr(capture.datetime, tz) }
  const when = pass?.tClosest ?? capture.datetime
  const status = statusWords(photo, mobile)
  const lead = cover === 'closest' ? 'Closest look' : cover === 'lastClear' ? 'Last clear look' : cover === 'clouded' ? 'Clouded over' : undefined
  const label = `${lead ? `${lead}: ` : ''}${meta.name}, ${t.day} ${t.time}${index >= 0 ? `, photo ${index + 1} of ${total}` : ''}`
  const replay = !detail && pass && onReplay ? () => onReplay(pass) : undefined
  const frameRef = useRef<HTMLDivElement>(null)
  const onView = () => {
    const el = frameRef.current?.querySelector<HTMLElement>('[data-photo-frame]')
    if (el) onExpand(photo, el)
  }

  let caption: ReactNode
  if (detail) {
    caption = (
      <figcaption className={s.cap}>
        <span className={s.capRow}>
          <span className={s.capMain}>
            {productLabel(capture)} · {cropWidthKm(capture) >= 100 ? int(cropWidthKm(capture)) : dec1(cropWidthKm(capture))} km · {coordsOf(model.report.place.lat, model.report.place.lon)}
          </span>
        </span>
        <span className={s.capRow}>
          <span className={s.credit}>{credit(capture)}</span>
          {status ? <span className={cx(s.status, photo.clouded && s.warn)}>{status}</span> : null}
        </span>
      </figcaption>
    )
  } else {
    // The summary card: two lines and one tap target (Replay this pass on the globe; the last clear look, which
    // has no pass, opens large instead). Laptops add Share.
    const note = cover === 'lastClear' ? (model.windowPhotos ? 'This week’s passes saw mostly cloud.' : 'Here’s the last clear look.') : undefined
    caption = (
      <figcaption className={s.mCap}>
        <span className={s.mLines}>
          <span className={s.mLine}>
            {lead ? <b className={cx(s.lead, cover === 'clouded' && s.warn)}>{lead} · </b> : null}
            <b>{meta.name}</b>
            {note ? null : (
              <>
                {' · '}
                {t.day}
                {mobile ? null : (
                  <>
                    {' · '}
                    {t.time} {t.zone}
                  </>
                )}
              </>
            )}
          </span>
          <span className={s.mLine}>
            {note ? `${t.day} · ` : mobile ? `${t.time} · ` : null}
            {int(capture.gsdM)} m
            <span className={s.dim}>
              {' · '}
              <Ago t={when} base={model.clock} />
            </span>
            {status ? <span className={cx(photo.clouded && s.warn)}> · {status}</span> : null}
          </span>
          {note ? <span className={cx(s.mLine, s.note)}>{note}</span> : null}
        </span>
        {replay ? (
          <button type="button" className={s.mReplay} onClick={replay} tabIndex={current ? 0 : -1} aria-label={`Replay this pass on the globe: ${meta.name}, ${t.day} ${t.time}`}>
            <Glyph name="play" size={10} />
            Replay<span className={s.tabletOnly}> this pass</span>
          </button>
        ) : (
          <button type="button" className={s.mReplay} onClick={onView} tabIndex={current ? 0 : -1} aria-label="View the photo large">
            <Mark name="expand" size={11} />
            View
          </button>
        )}
        {!mobile && pass && onShare ? (
          <button type="button" className={s.mShare} onClick={() => onShare(pass)} tabIndex={current ? 0 : -1} aria-label="Share this pass" title="Share this pass">
            <Glyph name="share" size={13} />
          </button>
        ) : null}
      </figcaption>
    )
  }

  return (
    <figure className={s.slide} role="group" aria-roledescription="slide" aria-label={label} aria-hidden={!current || undefined} data-current={current || undefined}>
      <div ref={frameRef} className={s.figure} data-image-end={current && detail ? '' : undefined}>
        <PhotoFrame
          photo={photo}
          model={model}
          load={near}
          current={current}
          reveal={detail ? (selected ? 'capture' : undefined) : index === 0 && cover ? 'hero' : undefined}
          chips={detail}
          echo={detail && selected}
          reticle={detail ? '26%' : mobile ? 40 : 44}
          gateOnVisible={mobile}
          onExpand={(el) => onExpand(photo, el)}
          className={detail ? s.square : s.heroFrame}
        />
        {caption}
      </div>
    </figure>
  )
})

/** Short words for what the photo shows at the place (honest about cloud, decision #2). */
function statusWords(p: Photo, short: boolean): string | undefined {
  const c = p.capture
  if (p.kind === 'mosaic') return short ? 'Mosaic' : 'Daily mosaic'
  if (p.clouded) return c.cloudCoverPct !== undefined && c.cloudCoverPct >= 70 ? `Clouded · ${int(c.cloudCoverPct)}%` : 'Cloud at spot'
  switch (c.spot) {
    case 'clear':
      return short ? 'Clear' : 'Clear at your spot'
    case 'cirrus':
      return 'Thin cirrus'
    case 'shadow':
      return short ? 'Shadow' : 'Cloud shadow'
    default:
      return c.cloudCoverPct !== undefined ? `Cloud ${int(c.cloudCoverPct)}%` : undefined
  }
}

/** Copyright / credit line required by each archive. */
export function credit(c: Photo['capture']): string {
  if (c.collection === 'sentinel-2-l2a') return `Contains modified Copernicus Sentinel data ${new Date(c.datetime || Date.now()).getUTCFullYear()}`
  if (c.collection === 'landsat-c2-l2') return 'Landsat: USGS / NASA'
  return 'NASA GIBS / EOSDIS'
}
