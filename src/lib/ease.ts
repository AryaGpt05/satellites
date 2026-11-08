/**
 * One easing family for JS, matching the CSS tokens in src/styles/tokens.css (--ease-out, --ease-in-out).
 * Spec (docs/DESIGN.md §5):
 *   entrances  ease-out      panels 480 ms, hero text 900 ms, 60 ms line stagger
 *   exits      ease-in-out   ~half the entrance (240 ms; curtains 480–640 ms)
 *   moves, handoffs, height changes  ease-in-out 480 ms
 *   count-ups  ease-out 700 ms · pushbroom linear 1600 ms
 *   camera     ease-in-out from rest, ease-out on retarget
 *   reduced motion: no scramble, no count-up, 160–200 ms fades
 */

/** CSS-style cubic-bezier timing function. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let u = x
    for (let i = 0; i < 8; i++) {
      const err = sampleX(u) - x
      if (Math.abs(err) < 1e-6) return sampleY(u)
      const dx = slopeX(u)
      if (Math.abs(dx) < 1e-6) break
      u -= err / dx
    }
    let lo = 0
    let hi = 1
    u = x
    for (let i = 0; i < 30; i++) {
      const v = sampleX(u)
      if (Math.abs(v - x) < 1e-6) break
      if (v < x) lo = u
      else hi = u
      u = (lo + hi) / 2
    }
    return sampleY(u)
  }
}

/** --ease-out */
export const easeOut = cubicBezier(0.2, 0, 0, 1)
/** --ease-in-out */
export const easeInOut = cubicBezier(0.6, 0, 0.2, 1)

/** CSS strings for inline styles / WAAPI */
export const EASE = { out: 'cubic-bezier(.2,0,0,1)', inOut: 'cubic-bezier(.6,0,.2,1)' } as const

/** Durations in ms */
export const DUR = { hover: 120, sm: 240, md: 480, lg: 900, exit: 240, curtain: 640, count: 700, pushbroom: 1600 } as const
