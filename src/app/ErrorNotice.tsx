import { useLayoutEffect, useRef } from 'react'
import { isStacked } from '@/lib/layout'
import { useApp } from '@/state/store'
import { Button, Label } from '@/ui/system'
import s from './ErrorNotice.module.css'

/**
 * Engine fault (phase 'error'). The place stays in the store, so "Try again" re-runs it without retyping;
 * "Back" returns to the landing.
 *
 * Like every phase's UI, the notice publishes what it covers (store.uiInsets) so the globe frames the place
 * clear of it: beside it on wide screens (as the landing's column), above it when stacked. It never clears
 * them; the next phase's owner overwrites.
 */
export function ErrorNotice({ message, onRetry, onBack }: { message?: string; onRetry?: () => void; onBack: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const publish = () => {
      // Layout box (offset*), not getBoundingClientRect: the entrance's translateY must not skew the frame.
      // The notice's offset parent is the full-viewport layer.
      const top = el.offsetTop
      const right = el.offsetLeft + el.offsetWidth
      const w = window.innerWidth
      const h = window.innerHeight
      useApp.getState().setUiInsets(isStacked(w, h) ? { bottom: Math.ceil(h - top + 24), left: 0, right: 0 } : { left: Math.ceil(right + 24), right: 0, bottom: 0 })
    }
    publish()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : undefined
    ro?.observe(el)
    window.addEventListener('resize', publish)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', publish)
    }
  }, [])

  return (
    <div ref={ref} className={s.wrap} role="alert">
      <Label>Fault</Label>
      <p className={s.msg}>{message ?? 'Something went wrong.'}</p>
      <div className={s.actions}>
        {onRetry ? (
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        <Button onClick={onBack}>Back</Button>
      </div>
    </div>
  )
}
