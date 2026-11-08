/**
 * Pure geometry for the mobile bottom sheet (see Sheet.tsx). Kept separate so it is unit-tested.
 * Heights are "visible heights": how many px of the sheet show above the bottom of the viewport.
 */

/** The smallest a snap may be: the grip plus a header line must stay reachable. */
export const MIN_SNAP_PX = 56

/**
 * Snap specs → ascending, de-duplicated visible heights in px.
 * A spec ≤ 1 is a fraction of the viewport height; > 1 is px. Each is clamped to [MIN_SNAP_PX, maxPx].
 */
export function snapHeightsPx(snaps: readonly number[], viewportH: number, maxPx = viewportH): number[] {
  const cap = Math.max(MIN_SNAP_PX, Math.min(maxPx, viewportH))
  const px = snaps
    .filter((v) => Number.isFinite(v) && v > 0)
    .map((v) => Math.round(v <= 1 ? v * viewportH : v))
    .map((v) => Math.min(cap, Math.max(MIN_SNAP_PX, v)))
    .sort((a, b) => a - b)
  const out: number[] = []
  for (const v of px) if (!out.length || v - out[out.length - 1] >= 1) out.push(v)
  return out.length ? out : [cap]
}

/** Release speed (px/ms) above which a drag counts as a flick toward the next snap. */
export const FLICK_PX_PER_MS = 0.45

/**
 * Where a released drag settles.
 * @param heights  ascending visible heights (px)
 * @param visible  visible height at release (px)
 * @param velocity px/ms, positive = sheet growing (finger moving up)
 */
export function resolveSnap(heights: readonly number[], visible: number, velocity: number, flick = FLICK_PX_PER_MS): number {
  if (heights.length <= 1) return 0
  if (Math.abs(velocity) >= flick) {
    if (velocity > 0) {
      const i = heights.findIndex((h) => h > visible + 1)
      return i === -1 ? heights.length - 1 : i
    }
    for (let i = heights.length - 1; i >= 0; i--) if (heights[i] < visible - 1) return i
    return 0
  }
  let best = 0
  for (let i = 1; i < heights.length; i++) if (Math.abs(heights[i] - visible) < Math.abs(heights[best] - visible)) best = i
  return best
}

/**
 * Rubber-band resistance past a bound: the further you pull, the less it moves. Monotonic,
 * approaches `limit` asymptotically, ≈ 1:1 for small overshoots.
 */
export function rubberband(overshoot: number, limit = 120): number {
  if (overshoot <= 0) return 0
  return limit * (1 - 1 / (overshoot / limit + 1))
}

/** Clamp an index into [0, n-1]. */
export const clampIndex = (i: number, n: number) => Math.max(0, Math.min(n - 1, Math.round(i)))
