/**
 * Field: the search input (DESIGN §8). No box, just a baseline hairline that thickens on focus, and a
 * blinking block caret drawn by us (the native caret is hidden).
 *
 * The block caret is positioned by measuring the text before the selection in an invisible mirror
 * that shares the input's font. It inverts the glyph beneath it (mix-blend-mode: difference), stays
 * solid while you type, hides while a range is selected, and does not blink under reduced motion.
 *
 *   <Field label="01 / Place" placeholder="Search a place" leading={<Glyph name="search" />}
 *          trailing={<Kbd>/</Kbd>} busy={searching} />
 *
 * All native input props pass through (value/onChange, aria-* for comboboxes, etc.), and the ref is
 * the <input>.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { cx } from './primitives'
import s from './Field.module.css'

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  /** Mono caps label above the line, left */
  label?: ReactNode
  /** Mono caps status above the line, right (e.g. "Searching", "3 results") */
  status?: ReactNode
  /** Element before the text (a Glyph) */
  leading?: ReactNode
  /** Element after the text (a Kbd hint or a button) */
  trailing?: ReactNode
  size?: 'md' | 'lg'
  /** Indeterminate activity: a short segment travels along the baseline */
  busy?: boolean
  /** Caveat state: the baseline turns --warn */
  invalid?: boolean
  className?: string
  inputClassName?: string
}

/** How long the caret stays solid after a keystroke before it resumes blinking. */
const TYPING_HOLD_MS = 600

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, status, leading, trailing, size = 'md', busy, invalid, className, inputClassName, id, onFocus, onBlur, ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null)
  const mirrorRef = useRef<HTMLSpanElement>(null)
  const caretRef = useRef<HTMLSpanElement>(null)
  const typingTimer = useRef(0)
  const [focused, setFocused] = useState(false)
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, [])

  /** Measure and move the block caret. Cheap: two text writes into a hidden span. */
  const place = useCallback(() => {
    const input = inputRef.current
    const mirror = mirrorRef.current
    const caret = caretRef.current
    if (!input || !mirror || !caret) return
    const value = input.value
    const start = input.selectionStart ?? value.length
    const end = input.selectionEnd ?? start
    mirror.textContent = value.slice(0, start)
    const x = mirror.getBoundingClientRect().width
    // Width of the glyph under the caret (or of a "0" cell at the end), so the block covers it exactly.
    mirror.textContent = value.slice(start, start + 1) || '0'
    const w = mirror.getBoundingClientRect().width
    const left = x - input.scrollLeft
    caret.style.transform = `translate3d(${left}px, 0, 0)`
    caret.style.width = `${Math.max(2, w)}px`
    caret.dataset.hidden = String(start !== end || left < -1 || left > input.clientWidth + 1)
  }, [])

  const markTyping = useCallback(() => {
    const caret = caretRef.current
    if (!caret) return
    caret.dataset.typing = 'true'
    window.clearTimeout(typingTimer.current)
    typingTimer.current = window.setTimeout(() => {
      if (caretRef.current) caretRef.current.dataset.typing = 'false'
    }, TYPING_HOLD_MS)
  }, [])

  // Re-place after every render (controlled value changes) and whenever selection moves.
  useLayoutEffect(() => {
    if (focused) place()
  })
  useEffect(() => {
    if (!focused) return
    const input = inputRef.current
    if (!input) return
    const onSel = () => {
      if (document.activeElement === input) place()
    }
    const onInput = () => {
      markTyping()
      place()
    }
    document.addEventListener('selectionchange', onSel)
    input.addEventListener('input', onInput)
    input.addEventListener('keydown', onSel)
    input.addEventListener('keyup', onSel)
    input.addEventListener('scroll', onSel)
    input.addEventListener('pointerup', onSel)
    window.addEventListener('resize', onSel)
    // Fonts swapping in after first paint change glyph widths.
    void document.fonts?.ready.then(onSel)
    return () => {
      document.removeEventListener('selectionchange', onSel)
      input.removeEventListener('input', onInput)
      input.removeEventListener('keydown', onSel)
      input.removeEventListener('keyup', onSel)
      input.removeEventListener('scroll', onSel)
      input.removeEventListener('pointerup', onSel)
      window.removeEventListener('resize', onSel)
    }
  }, [focused, place, markTyping])
  useEffect(() => () => window.clearTimeout(typingTimer.current), [])

  return (
    <div
      className={cx(s.field, size === 'lg' && s.lg, focused && s.focused, invalid && s.invalid, rest.disabled && s.disabled, className)}
      data-busy={busy ? 'true' : undefined}
    >
      {label || status ? (
        <div className={s.meta}>
          {label ? (
            <label className={s.label} htmlFor={id}>
              {label}
            </label>
          ) : (
            <span />
          )}
          {status ? (
            <span className={s.status} aria-live="polite">
              {status}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        className={s.control}
        onPointerDown={(e) => {
          // A press on the line's padding (not on the input or a button) still focuses the input.
          if (e.target !== e.currentTarget) return
          e.preventDefault()
          inputRef.current?.focus()
        }}
      >
        {leading ? <span className={s.leading}>{leading}</span> : null}
        <span className={s.inputWrap}>
          <input
            ref={inputRef}
            id={id}
            className={cx(s.input, inputClassName)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onFocus={(e) => {
              setFocused(true)
              onFocus?.(e)
            }}
            onBlur={(e) => {
              setFocused(false)
              onBlur?.(e)
            }}
            {...rest}
          />
          <span ref={mirrorRef} className={s.mirror} aria-hidden />
          <span ref={caretRef} className={s.caret} data-hidden={focused ? 'false' : 'true'} aria-hidden />
        </span>
        {trailing ? <span className={s.trailing}>{trailing}</span> : null}
      </div>
      <span className={s.line} aria-hidden />
      <span className={s.lineFocus} aria-hidden />
      <span className={s.scan} aria-hidden />
    </div>
  )
})
