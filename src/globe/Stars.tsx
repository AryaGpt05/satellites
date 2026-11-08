/**
 * Real stars (Hipparcos, V ≤ 5.2) as sparse, dim points in a few magnitude classes. No twinkle, no nebulae.
 * They are inertial: placed in ECI from RA/Dec and rotated about the world Y axis by −GMST (see geo.ts), and
 * centred on the camera every frame so they sit at infinity with no parallax.
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color, Group, ShaderMaterial } from 'three'
import { DEG } from '@/lib/geo'
import { palette } from '@/ui/system/palette'
import { starsFragment, starsVertex } from './shaders/points'
import { STAR_STRIDE, STARS } from './starData'
import { FRAME, useRuntime } from './runtime'

const SKY_RADIUS = 90
/** Faintest magnitude drawn. Sparse on purpose: the satellites, not the sky, are the subject. */
const MAG_LIMIT = 4.6

/** Magnitude classes → CSS px size and alpha. Brightest stars are still quieter than the UI's bone. */
export function starClass(mag: number): { size: number; alpha: number } {
  if (mag < 0.5) return { size: 2.4, alpha: 0.8 }
  if (mag < 1.5) return { size: 2.0, alpha: 0.66 }
  if (mag < 2.5) return { size: 1.6, alpha: 0.5 }
  if (mag < 3.5) return { size: 1.25, alpha: 0.36 }
  return { size: 1.0, alpha: 0.24 }
}

/** A restrained colour from B−V: blue-white stars a touch cool, red giants a touch warm, mostly bone. */
function tintFor(bv: number, out: Color): Color {
  const bone = new Color(palette.bone)
  const hot = new Color('#c9d8ff')
  const cool = new Color('#ffd2a6')
  const t = Math.max(-0.3, Math.min(1.8, bv))
  if (t < 0.4) out.copy(bone).lerp(hot, ((0.4 - t) / 0.7) * 0.6)
  else out.copy(bone).lerp(cool, ((t - 0.4) / 1.4) * 0.55)
  return out
}

export function Stars() {
  const rt = useRuntime()
  const group = useRef<Group>(null)

  const geometry = useMemo(() => {
    const n = STARS.length / STAR_STRIDE
    const pos: number[] = []
    const size: number[] = []
    const alpha: number[] = []
    const tint: number[] = []
    const c = new Color()
    for (let i = 0; i < n; i++) {
      const ra = STARS[i * STAR_STRIDE] * DEG
      const dec = STARS[i * STAR_STRIDE + 1] * DEG
      const mag = STARS[i * STAR_STRIDE + 2]
      const bv = STARS[i * STAR_STRIDE + 3]
      if (mag > MAG_LIMIT) continue
      // ECI unit vector, then ECI → world at GMST = 0: (x, y, z) → (x, z, −y)
      const x = Math.cos(dec) * Math.cos(ra)
      const y = Math.cos(dec) * Math.sin(ra)
      const z = Math.sin(dec)
      pos.push(x * SKY_RADIUS, z * SKY_RADIUS, -y * SKY_RADIUS)
      const k = starClass(mag)
      size.push(k.size)
      alpha.push(k.alpha)
      tintFor(bv, c)
      tint.push(c.r, c.g, c.b)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('aSize', new BufferAttribute(new Float32Array(size), 1))
    g.setAttribute('aAlpha', new BufferAttribute(new Float32Array(alpha), 1))
    g.setAttribute('aTint', new BufferAttribute(new Float32Array(tint), 3))
    return g
  }, [])

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: starsVertex,
        fragmentShader: starsFragment,
        transparent: true,
        depthWrite: false,
        uniforms: { uPx: rt.uniforms.uPx, uReveal: { value: 0 } },
      }),
    [rt],
  )
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  useFrame((state, dt) => {
    const g = group.current
    if (!g) return
    g.position.copy(state.camera.position)
    g.rotation.y = -rt.gmst
    const u = material.uniforms.uReveal
    if (u.value < 1) u.value = Math.min(1, u.value + dt / (rt.reducedMotion ? 0.2 : 2.4))
  }, FRAME.scene)

  return (
    <group ref={group}>
      <points geometry={geometry} material={material} renderOrder={-10} frustumCulled={false} />
    </group>
  )
}
