/**
 * Screen-space picking for the satellite field (pure functions, unit-tested).
 * Positions come from the engine's TS reference of the shader (keplerJ2World), so what you hover is exactly
 * the point the GPU drew.
 */
import { Vector3, type Camera } from 'three'

/** True if the straight line from `cam` to `p` passes through the unit sphere (Earth) before reaching p. */
export function occludedByEarth(cam: Vector3, p: Vector3, radius = 1): boolean {
  const dx = p.x - cam.x
  const dy = p.y - cam.y
  const dz = p.z - cam.z
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-9) return false
  const ux = dx / len
  const uy = dy / len
  const uz = dz / len
  const tca = -(cam.x * ux + cam.y * uy + cam.z * uz)
  if (tca < 0) return false // the sphere's centre is behind the camera along this line
  const d2 = cam.x * cam.x + cam.y * cam.y + cam.z * cam.z - tca * tca
  const r2 = radius * radius
  if (d2 >= r2) return false
  const t0 = tca - Math.sqrt(r2 - d2)
  return t0 > 0 && t0 < len - 1e-6
}

const _v = new Vector3()

/**
 * Project world points to CSS pixels. Writes [x, y] per point into `out` (NaN when behind the camera or
 * hidden behind the Earth).
 */
export function projectPoints(
  positions: Float32Array,
  count: number,
  camera: Camera,
  width: number,
  height: number,
  out: Float32Array,
): void {
  const cam = camera.position
  for (let i = 0; i < count; i++) {
    _v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
    if (occludedByEarth(cam, _v)) {
      out[i * 2] = NaN
      out[i * 2 + 1] = NaN
      continue
    }
    _v.project(camera)
    if (_v.z > 1 || _v.z < -1) {
      out[i * 2] = NaN
      out[i * 2 + 1] = NaN
      continue
    }
    out[i * 2] = (_v.x * 0.5 + 0.5) * width
    out[i * 2 + 1] = (-_v.y * 0.5 + 0.5) * height
  }
}

/** Index of the nearest projected point within `radiusPx` of (x, y), or −1. */
export function nearestWithin(screen: Float32Array, count: number, x: number, y: number, radiusPx: number): number {
  let best = -1
  let bestD = radiusPx * radiusPx
  for (let i = 0; i < count; i++) {
    const sx = screen[i * 2]
    if (Number.isNaN(sx)) continue
    const dx = sx - x
    const dy = screen[i * 2 + 1] - y
    const d = dx * dx + dy * dy
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}
