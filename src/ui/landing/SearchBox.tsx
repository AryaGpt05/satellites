/**
 * Place search: a combobox over `imagery.searchPlaces` (Photon / OSM; coordinates are accepted too).
 *
 *   typing      debounced 220 ms, previous request aborted
 *   ↑ / ↓       move through suggestions (wraps through "none")
 *   Enter       choose the highlighted suggestion, else the first; if results are stale, search now
 *   Esc         close the list, then clear, then leave the field
 *   /           focus the field from anywhere (unless already typing somewhere)
 *
 * States shown in the field's status slot and the list: searching, results, no match, unavailable.
 * ARIA 1.2 combobox pattern: the input owns a listbox via aria-controls / aria-activedescendant.
 *
 * The list is capped to the space above the on-screen keyboard (visualViewport), so every option can
 * be scrolled into view while typing on a phone. `onBeforeFocus` lets the landing move the field
 * before a touch focuses it (see Landing.tsx: iOS pans to the focused field, so it must already be
 * where it will stay).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { isAbortError, searchPlaces } from '@/imagery'
import type { Place } from '@/types'
import { Field, Glyph, Kbd, cx, fmtLat, fmtLon, useIsMobile } from '@/ui/system'
import { canSubmitQuery, clampActive, enterTarget, isTypingTarget, stepActive } from './listNav'
import s from './SearchBox.module.css'

const DEBOUNCE_MS = 220
const MIN_QUERY = 2

type Status = 'idle' | 'searching' | 'error'

export function SearchBox({
  onSubmit,
  onFocusChange,
  disabled,
  autoFocus,
  idleTrailing,
  statusOverride,
  metaHidden,
  onBeforeFocus,
}: {
  onSubmit: (place: Place) => void
  onFocusChange?: (focused: boolean) => void
  disabled?: boolean
  autoFocus?: boolean
  /** Shown at the end of the line while the field is empty (e.g. "Use my location") */
  idleTrailing?: ReactNode
  /** Replaces the search status above the line (e.g. a locating readout) */
  statusOverride?: ReactNode
  /** Visually hide the label + status row (still read by assistive tech) */
  metaHidden?: boolean
  /**
   * Touch: called on a tap of the unfocused field, before it is focused, so the caller can move it to
   * where it will sit while typing. The field is then focused programmatically.
   */
  onBeforeFocus?: () => void
}) {
  const mobile = useIsMobile()
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const inputId = useId()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ q: string; places: Place[] } | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const ctrl = useRef<AbortController | null>(null)
  const timer = useRef(0)
  const queryRef = useRef('')
  queryRef.current = query

  const places = result?.places ?? []
  const fresh = !!result && result.q === query.trim()

  /** Search now. Resolves with the places for `q` (empty when aborted, failed or too short). */
  const run = useCallback((q: string): Promise<Place[]> => {
    ctrl.current?.abort()
    window.clearTimeout(timer.current)
    const trimmed = q.trim()
    if (trimmed.length < MIN_QUERY) {
      setResult(null)
      setStatus('idle')
      setOpen(false)
      return Promise.resolve([])
    }
    const c = new AbortController()
    ctrl.current = c
    setStatus('searching')
    return searchPlaces(trimmed, c.signal).then(
      (found) => {
        if (c.signal.aborted) return []
        setResult({ q: trimmed, places: found })
        setStatus('idle')
        setActive((a) => clampActive(a, found.length))
        setOpen(true)
        return found
      },
      (err: unknown) => {
        if (c.signal.aborted || isAbortError(err)) return []
        setResult({ q: trimmed, places: [] })
        setStatus('error')
        setOpen(true)
        return []
      },
    )
  }, [])

  useEffect(
    () => () => {
      ctrl.current?.abort()
      window.clearTimeout(timer.current)
    },
    [],
  )

  // "/" focuses the search from anywhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      // Not while a modal (About) is open: the field is behind it.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const choose = (place: Place) => {
    ctrl.current?.abort()
    window.clearTimeout(timer.current)
    setQuery(place.label)
    setOpen(false)
    setActive(-1)
    inputRef.current?.blur()
    onSubmit(place)
  }

  const submit = () => {
    if (fresh && places.length) {
      choose(places[enterTarget(active, places.length)])
      return
    }
    const q = query
    void run(q).then((found) => {
      // Only act if the user hasn't typed since.
      if (found.length && queryRef.current === q) choose(found[0])
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!places.length) return
        e.preventDefault()
        setOpen(true)
        setActive((a) => stepActive(open ? a : -1, places.length, e.key === 'ArrowDown' ? 1 : -1))
        break
      }
      case 'Enter':
        if (e.nativeEvent.isComposing) return
        e.preventDefault()
        submit()
        break
      case 'Escape':
        if (open) {
          setOpen(false)
          setActive(-1)
        } else if (query) {
          ctrl.current?.abort()
          setQuery('')
          setResult(null)
          setStatus('idle')
        } else {
          inputRef.current?.blur()
        }
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  const statusText =
    status === 'searching' ? (
      'Searching'
    ) : status === 'error' && fresh ? (
      'Search unavailable'
    ) : fresh ? (
      places.length ? (
        `${places.length} ${places.length === 1 ? 'match' : 'matches'}`
      ) : (
        'No match'
      )
    ) : focused && !query ? (
      'Name, address or lat, lon'
    ) : undefined

  const showList = open && focused && fresh
  const activeId = showList && active >= 0 ? `${listId}-${active}` : undefined

  // Keep the list in view: cap it to the space between the field and the bottom of the *visual*
  // viewport, which on phones ends at the top of the on-screen keyboard (innerHeight does not change
  // when iOS / Android open it). It scrolls past that.
  const wrapRef = useRef<HTMLDivElement>(null)
  const [maxH, setMaxH] = useState<number>()
  // The field's bottom edge, read once per focus (the list closes and reopens as you type: reading
  // layout each time would force it on every keystroke). Viewport changes re-read it.
  const field = useRef<{ bottom: number; inset: number } | null>(null)
  const readField = () => {
    const wrap = wrapRef.current
    if (!wrap) return null
    field.current = {
      bottom: wrap.getBoundingClientRect().bottom,
      inset: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bezel-inset')) || 16,
    }
    return field.current
  }
  useEffect(() => {
    field.current = null
    if (!focused) return
    // Read it once the field has settled where it types (after the landing's 320 ms lift), at the
    // top of a frame, when layout is clean and the read costs nothing.
    let raf = 0
    const t = window.setTimeout(() => (raf = requestAnimationFrame(readField)), 360)
    return () => {
      window.clearTimeout(t)
      cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused])
  useLayoutEffect(() => {
    if (!showList) return
    let raf = 0
    const measure = (fresh = false) => {
      raf = 0
      const f = fresh || !field.current ? readField() : field.current
      if (!f) return
      const { bottom: fieldBottom, inset } = f
      const vv = window.visualViewport
      const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight
      // Above the keyboard: just clear of it. Without one: inside the bezel.
      const clear = vv && vv.height < window.innerHeight - 80 ? 8 : inset + 12
      setMaxH(Math.max(120, Math.min(360, bottom - fieldBottom - clear)))
    }
    const later = () => {
      if (!raf) raf = requestAnimationFrame(() => measure(true))
    }
    measure()
    window.addEventListener('resize', later)
    window.visualViewport?.addEventListener('resize', later)
    window.visualViewport?.addEventListener('scroll', later)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', later)
      window.visualViewport?.removeEventListener('resize', later)
      window.visualViewport?.removeEventListener('scroll', later)
    }
  }, [showList])

  // Touch tap on the unfocused field: let the caller lift it first, then focus it ourselves. The
  // press's own focus/click are suppressed (the field is no longer under the finger by then).
  const tap = useRef<{ id: number; x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (!onBeforeFocus || e.pointerType !== 'touch' || focused || disabled) return
    e.preventDefault()
    tap.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
  }
  const onPointerUp = (e: React.PointerEvent<HTMLInputElement>) => {
    const t = tap.current
    tap.current = null
    if (!t || t.id !== e.pointerId || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 12) return
    onBeforeFocus?.()
    inputRef.current?.focus({ preventScroll: true })
    swallowGhostClick(t.x, t.y)
  }
  // The primary action only shows when it can do something: never next to "No match" or "unavailable".
  const canSubmit = canSubmitQuery(query, MIN_QUERY, result && { q: result.q, count: result.places.length })

  return (
    <div ref={wrapRef} className={s.search}>
      <Field
        ref={inputRef}
        id={inputId}
        size="lg"
        className={s.field}
        label={
          <>
            {/* the index is decoration: the accessible name is just "Place" */}
            <span aria-hidden>
              <span className={s.idx}>01</span> /{' '}
            </span>
            Place
          </>
        }
        status={statusOverride ?? statusText}
        metaHidden={metaHidden}
        busy={status === 'searching'}
        invalid={status === 'error' && fresh}
        leading={<Glyph name="search" size={16} />}
        trailing={
          <>
            {/* the "/" shortcut, where a keyboard is likely: gone once you're in the field */}
            {!query && !focused && !mobile ? <Kbd className={s.kbd}>/</Kbd> : null}
            {query && !disabled ? (
              <button
                type="button"
                className={s.clear}
                aria-label="Clear search"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  ctrl.current?.abort()
                  setQuery('')
                  setResult(null)
                  setStatus('idle')
                  inputRef.current?.focus()
                }}
              >
                <Glyph name="close" size={12} />
              </button>
            ) : null}
            {canSubmit ? (
              <button
                type="button"
                className={s.go}
                aria-label="Show what passed over this place"
                onPointerDown={(e) => e.preventDefault()}
                onClick={submit}
                disabled={disabled}
              >
                <Glyph name="arrow-right" size={16} />
              </button>
            ) : !query ? (
              idleTrailing
            ) : null}
          </>
        }
        placeholder="Search a place"
        value={query}
        disabled={disabled}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        aria-keyshortcuts="/"
        enterKeyHint="search"
        inputMode="search"
        onChange={(e) => {
          const v = e.target.value
          setQuery(v)
          setActive(-1)
          window.clearTimeout(timer.current)
          if (v.trim().length < MIN_QUERY) {
            ctrl.current?.abort()
            setResult(null)
            setStatus('idle')
            setOpen(false)
            return
          }
          timer.current = window.setTimeout(() => void run(v), DEBOUNCE_MS)
        }}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (tap.current = null)}
        onFocus={() => {
          setFocused(true)
          if (fresh) setOpen(true)
          onFocusChange?.(true)
        }}
        onBlur={() => {
          setFocused(false)
          setOpen(false)
          onFocusChange?.(false)
        }}
      />

      <div className={cx(s.list, showList && s.listOpen)} style={maxH ? { maxHeight: maxH } : undefined} data-suggestions>
        {/* Messages sit outside the listbox: only options belong in it. The field's status announces them. */}
        {showList && status === 'error' ? (
          <p className={s.empty}>The place search isn’t answering. Coordinates such as 43.47, −80.54 still work.</p>
        ) : null}
        {showList && status !== 'error' && !places.length ? (
          <p className={s.empty}>Nothing matches “{result?.q}”. Try a city, a landmark, or coordinates.</p>
        ) : null}
        <div id={listId} role="listbox" aria-label="Places">
          {showList
            ? places.map((p, i) => (
                <div
                  key={`${p.lat},${p.lon},${p.label}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={cx(s.option, i === active && s.active)}
                  onPointerDown={(e) => e.preventDefault()}
                  onPointerMove={() => i !== active && setActive(i)}
                  onClick={() => choose(p)}
                >
                  <span className={s.optText}>
                    <span className={s.optLabel}>{p.label}</span>
                    {p.sublabel ? <span className={s.optSub}>{p.sublabel}</span> : null}
                  </span>
                  {/* a place named by its own coordinates (open sea, geocoder offline) doesn't repeat them */}
                  {p.label.includes('°') ? null : (
                    <span className={s.optCoord}>
                      {fmtLat(p.lat, 2)} {fmtLon(p.lon, 2)}
                    </span>
                  )}
                </div>
              ))
            : null}
        </div>
      </div>
    </div>
  )
}

/** Swallow the click a touch tap produces after the layout moved under the finger. */
function swallowGhostClick(x: number, y: number) {
  const done = () => {
    document.removeEventListener('click', onClick, true)
    window.clearTimeout(timer)
  }
  const onClick = (e: MouseEvent) => {
    if (Math.hypot(e.clientX - x, e.clientY - y) < 32) {
      e.preventDefault()
      e.stopPropagation()
    }
    done()
  }
  document.addEventListener('click', onClick, true)
  const timer = window.setTimeout(done, 700)
}
