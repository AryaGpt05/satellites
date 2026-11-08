/**
 * Pushbroom reveal geometry (pure). The image is north-up; the satellite moves along `headingDeg`
 * (degrees clockwise from north). A pushbroom sensor builds the picture one cross-track line at a
 * time as it moves, so the reveal front is a line perpendicular to the heading that advances along it.
 *
 * Screen space: x right, y down. North = −y.
 */

export interface Vec {
  x: number
  y: number
}

/** Unit vector of motion in screen space for a compass heading. 0° → up, 90° → right, 180° → down. */
export function motionVector(headingDeg: number): Vec {
  const h = (headingDeg * Math.PI) / 180
  return { x: Math.sin(h), y: -Math.cos(h) }
}

/** Range of s = p·d over the rectangle [0,w]×[0,h]: where the reveal front starts and ends. */
export function sweepRange(w: number, h: number, d: Vec): [number, number] {
  const s = [0, w * d.x, h * d.y, w * d.x + h * d.y]
  return [Math.min(...s), Math.max(...s)]
}

/**
 * Polygon (4 points) covering the part of the rectangle already scanned at front position `s`:
 * every point with p·d ≤ s. Built big enough to cover the whole rect; the canvas clips the rest.
 */
export function scannedPolygon(w: number, h: number, d: Vec, s: number, back = 0): Vec[] {
  const n = { x: -d.y, y: d.x } // along the front
  const L = (w + h) * 2
  const front = { x: d.x * s, y: d.y * s }
  const rear = back > 0 ? { x: d.x * (s - back), y: d.y * (s - back) } : { x: d.x * (s - L), y: d.y * (s - L) }
  return [
    { x: front.x + n.x * L, y: front.y + n.y * L },
    { x: front.x - n.x * L, y: front.y - n.y * L },
    { x: rear.x - n.x * L, y: rear.y - n.y * L },
    { x: rear.x + n.x * L, y: rear.y + n.y * L },
  ]
}

/** The front line's two far endpoints at position s (for stroking the scan line). */
export function frontLine(w: number, h: number, d: Vec, s: number): [Vec, Vec] {
  const n = { x: -d.y, y: d.x }
  const L = (w + h) * 2
  return [
    { x: d.x * s + n.x * L, y: d.y * s + n.y * L },
    { x: d.x * s - n.x * L, y: d.y * s - n.y * L },
  ]
}

/** Reveal duration (DESIGN §5: ≈ 1.6 s) and the line count shown in the counter. */
export const REVEAL_MS = 1600

/** Pushbroom sensors scan at a constant rate, so progress is linear in time (no easing). */
export function revealProgress(elapsedMs: number, duration = REVEAL_MS): number {
  return Math.min(1, Math.max(0, elapsedMs / duration))
}

/** "0412" */
export const lineLabel = (line: number, digits = 4) => String(Math.round(line)).padStart(digits, '0')
