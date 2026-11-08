/**
 * Screen-space hairlines (1 CSS px at any DPR) as instanced quads, one instance per segment, with per-vertex
 * alpha so trails can fade. Cheap to update: a polyline of N points rewrites 2·N floats per attribute.
 */
import {
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Float32BufferAttribute,
  ShaderMaterial,
  Vector2,
  type Vector3,
} from 'three'
import { hairlineFragment, hairlineVertex } from './shaders/overlay'

export class Hairline {
  readonly geometry = new InstancedBufferGeometry()
  readonly material: ShaderMaterial
  private start: InstancedBufferAttribute
  private end: InstancedBufferAttribute
  private alpha: InstancedBufferAttribute
  private capacity: number

  constructor(opts: { capacity: number; color: Color; width?: number; opacity?: number; uPx: { value: number }; depthTest?: boolean }) {
    this.capacity = Math.max(1, opts.capacity)
    // Quad corners: x = 0 (start) / 1 (end), y = −1 / +1 (side).
    this.geometry.setAttribute('position', new Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3))
    this.geometry.setIndex([0, 1, 2, 0, 2, 3])
    this.start = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3)
    this.end = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3)
    this.alpha = new InstancedBufferAttribute(new Float32Array(this.capacity * 2), 2)
    this.geometry.setAttribute('aStart', this.start)
    this.geometry.setAttribute('aEnd', this.end)
    this.geometry.setAttribute('aAlpha', this.alpha)
    this.geometry.instanceCount = 0
    this.material = new ShaderMaterial({
      vertexShader: hairlineVertex,
      fragmentShader: hairlineFragment,
      transparent: true,
      depthWrite: false,
      depthTest: opts.depthTest ?? true,
      uniforms: {
        uResolution: { value: new Vector2(1, 1) },
        uWidth: { value: opts.width ?? 1 },
        uPx: opts.uPx,
        uColor: { value: opts.color },
        uOpacity: { value: opts.opacity ?? 1 },
      },
    })
  }

  /** Set the polyline. `alphas` (per point) defaults to 1. Points beyond capacity are dropped. */
  setPoints(points: readonly Vector3[], alphas?: ArrayLike<number>, count = points.length) {
    const n = Math.min(count, this.capacity + 1)
    const s = this.start.array as Float32Array
    const e = this.end.array as Float32Array
    const a = this.alpha.array as Float32Array
    let k = 0
    for (let i = 0; i < n - 1; i++) {
      const p = points[i]
      const q = points[i + 1]
      s[k * 3] = p.x
      s[k * 3 + 1] = p.y
      s[k * 3 + 2] = p.z
      e[k * 3] = q.x
      e[k * 3 + 1] = q.y
      e[k * 3 + 2] = q.z
      a[k * 2] = alphas ? alphas[i] : 1
      a[k * 2 + 1] = alphas ? alphas[i + 1] : 1
      k++
    }
    this.geometry.instanceCount = k
    this.start.needsUpdate = true
    this.end.needsUpdate = true
    this.alpha.needsUpdate = true
  }

  setResolution(w: number, h: number) {
    ;(this.material.uniforms.uResolution.value as Vector2).set(w, h)
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
