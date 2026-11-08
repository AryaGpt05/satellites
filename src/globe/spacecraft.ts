/**
 * Procedural low-poly spacecraft for the acquisition sequence: a box bus, the imaging instrument on the nadir face
 * with a signal-coloured aperture, one solar wing on a short yoke (Sentinel-2, Landsat and the JPSS imagers all fly a
 * single wing) and a small antenna boom. Model frame: +X = velocity, +Y = left of track, +Z = zenith; the bus sits at
 * the origin. Built once (a few hundred vertices); per-vertex `aPart` picks the material zone in the shader.
 */
import { BufferAttribute, BufferGeometry } from 'three'

/** Model span (units) along Y: the wing tip to the boom tip. The scene scales this to a fixed screen size. */
export const SPACECRAFT_SPAN = 6.6

/** Parts (shaders/acquisition.ts spacecraftFragment). */
const BUS = 0
const ARRAY = 1
const ACCENT = 2
const DARK = 3

export function buildSpacecraftGeometry(): BufferGeometry {
  const pos: number[] = []
  const nrm: number[] = []
  const uv: number[] = []
  const part: number[] = []
  const index: number[] = []

  /** Axis-aligned box centred at (cx, cy, cz) with size (sx, sy, sz): 6 faces × 4 vertices, outward normals. */
  const box = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, p: number) => {
    const hx = sx / 2
    const hy = sy / 2
    const hz = sz / 2
    // [normal, u axis, v axis, half sizes along n/u/v]
    const faces: [number[], number[], number[], number, number, number][] = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1], hx, hy, hz],
      [[-1, 0, 0], [0, -1, 0], [0, 0, 1], hx, hy, hz],
      [[0, 1, 0], [-1, 0, 0], [0, 0, 1], hy, hx, hz],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1], hy, hx, hz],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0], hz, hx, hy],
      [[0, 0, -1], [1, 0, 0], [0, -1, 0], hz, hx, hy],
    ]
    for (const [n, u, v, hn, hu, hv] of faces) {
      const base = pos.length / 3
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        pos.push(cx + n[0] * hn + u[0] * hu * a + v[0] * hv * b, cy + n[1] * hn + u[1] * hu * a + v[1] * hv * b, cz + n[2] * hn + u[2] * hu * a + v[2] * hv * b)
        nrm.push(n[0], n[1], n[2])
        uv.push((a + 1) / 2, (b + 1) / 2)
        part.push(p)
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }

  // Bus and its upper deck.
  box(0, 0, 0.15, 1.5, 1.2, 1.5, BUS)
  box(0, 0, 1.0, 1.1, 0.9, 0.2, DARK)
  // The instrument on the nadir face, its aperture looking straight down.
  box(0.1, 0, -0.85, 0.95, 0.8, 0.5, DARK)
  box(0.1, 0, -1.12, 0.55, 0.5, 0.05, ACCENT)
  // Solar wing on a yoke (+Y), its cells facing zenith.
  box(0, 0.95, 0.35, 0.12, 0.7, 0.12, DARK)
  box(0, 3.15, 0.35, 1.7, 3.7, 0.06, ARRAY)
  // Antenna boom and dish plate (−Y).
  box(-0.3, -0.95, 0.4, 0.08, 0.7, 0.08, DARK)
  box(-0.3, -1.35, 0.4, 0.42, 0.06, 0.42, BUS)

  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  g.setAttribute('aPart', new BufferAttribute(new Float32Array(part), 1))
  g.setIndex(index)
  g.computeBoundingSphere()
  return g
}
