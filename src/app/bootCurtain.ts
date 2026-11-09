/**
 * The boot curtain's exit. index.html paints the loading screen (#boot-static): the Watched wordmark centred on
 * ink, its full stop breathing on the compositor. React never replaces it; when boot ends (the phase leaves
 * 'boot'), Main calls exitBootCurtain() in the commit that mounts the landing (or the results panel), before paint:
 *
 *   the stop settles to full                      240 ms, ease-out
 *   the wordmark glides and shrinks onto the HUD's own wordmark (top left), 760 ms: it rises and shrinks
 *   first (RISE), then slides left along the top (ease-in-out), so it never crosses the landing's headline
 *   the ink fades off the globe and the landing   560 ms after 120 ms, ease-in-out
 *   in the frame after the glide lands: html[data-boot] goes (the HUD's wordmark shows, same place, same size)
 *   and the curtain is removed
 *
 * Transform and opacity only, on the compositor, so it stays smooth through whatever the main thread is doing
 * in that second (the landing's first render, texture uploads). Nothing changes layout.
 * Reduced motion: one 200 ms fade, nothing moves. If the HUD's wordmark can't be measured, the wordmark fades
 * with the ink instead of gliding.
 */
import { EASE } from '@/lib/ease'
import { prefersReducedMotion } from '@/ui/system'

export const CURTAIN = { settle: 240, glide: 760, inkDelay: 120, ink: 560, reduced: 200 } as const
/** The vertical move and the scale lead the sideways move: most of the rise is done by the time the headline wipes in. */
const RISE = 'cubic-bezier(.4,0,.1,1)'

let exited = false

/** Remove the curtain for good (sandboxes, tests, and the end of the exit). Idempotent. */
export function dropBootCurtain(): void {
  exited = true
  delete document.documentElement.dataset.boot
  document.getElementById('boot-static')?.remove()
}

export function exitBootCurtain(): void {
  if (exited) return
  exited = true
  const root = document.getElementById('boot-static')
  const ink = root?.querySelector<HTMLElement>('.bs-ink')
  const glider = root?.querySelector<HTMLElement>('.bs-glide')
  const mark = root?.querySelector<HTMLElement>('.bs-mark')
  if (!root || !ink || !glider || !mark || typeof root.animate !== 'function') {
    dropBootCurtain()
    return
  }
  const finish = () => dropBootCurtain()

  if (prefersReducedMotion()) {
    root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CURTAIN.reduced, easing: 'linear', fill: 'forwards' }).finished.then(finish, finish)
    return
  }

  // The stop stops breathing: from wherever the breath is, up to full, so it lands as the HUD's (solid) dot.
  const dot = root.querySelector<HTMLElement>('.bs-dot')
  if (dot) {
    const now = Number.parseFloat(getComputedStyle(dot).opacity)
    dot.style.animation = 'none'
    dot.animate([{ opacity: Number.isFinite(now) ? now : 1 }, { opacity: 1 }], { duration: CURTAIN.settle, easing: EASE.out, fill: 'forwards' })
  }

  ink.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CURTAIN.ink, delay: CURTAIN.inkDelay, easing: EASE.inOut, fill: 'forwards' })

  const target = document.querySelector<SVGElement>('[data-hud-wordmark] svg')
  const from = mark.getBoundingClientRect()
  const to = target?.getBoundingClientRect()
  let glide: Promise<unknown>
  if (to && to.width > 0 && to.height > 0 && from.width > 0 && from.height > 0) {
    const k = to.height / from.height
    const dx = to.left + to.width / 2 - (from.left + from.width / 2)
    const dy = to.top + to.height / 2 - (from.top + from.height / 2)
    // Two elements, two curves: translations commute and the scale is about the mark's own centre, so the end
    // state is exactly translate(dx, dy) scale(k): the HUD wordmark's box.
    const side = glider.animate([{ transform: 'translateX(0px)' }, { transform: `translateX(${dx}px)` }], { duration: CURTAIN.glide, easing: EASE.inOut, fill: 'forwards' })
    const rise = mark.animate([{ transform: 'translateY(0px) scale(1)' }, { transform: `translateY(${dy}px) scale(${k})` }], { duration: CURTAIN.glide, easing: RISE, fill: 'forwards' })
    glide = Promise.all([side.finished, rise.finished])
  } else {
    // No HUD wordmark to land on: show it now and let the centred one leave with the ink.
    delete document.documentElement.dataset.boot
    glide = mark.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CURTAIN.ink, delay: CURTAIN.inkDelay, easing: EASE.inOut, fill: 'forwards' }).finished
  }
  glide.then(finish, finish)
}
