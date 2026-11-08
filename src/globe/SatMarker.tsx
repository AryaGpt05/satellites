/**
 * A single satellite, emphasised: its category glyph (DESIGN.md §2) drawn at its position, and a screen anchor
 * for its instrument-style callout (drawn by GlobeOverlay in the DOM). Both follow a `track` function evaluated
 * every frame, and hide when the satellite is behind the Earth.
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial, Vector3 } from 'three'
import type { SatCategory } from '@/types'
import { palette } from '@/ui/system/palette'
import { CATEGORY_INDEX } from './data'
import { lin } from './Earth'
import { occludedByEarth } from './picking'
import { createAnchor, FRAME, useRuntime } from './runtime'
import { glyphFragment, glyphVertex } from './shaders/points'

/** Writes the world position into `out`; returns the altitude in km, or null if unavailable right now. */
export type SatTrackFn = (out: Vector3) => number | null

export type MarkTone = 'signal' | 'bone' | 'ice'

const toneColor = (tone: MarkTone) => lin(tone === 'signal' ? palette.signal : tone === 'ice' ? palette.ice : palette.bone)

export function SatGlyph({
  category,
  filled,
  tone,
  track,
  size = 13,
}: {
  category: SatCategory
  filled: boolean
  tone: MarkTone
  track: SatTrackFn
  size?: number
}) {
  const rt = useRuntime()
  const points = useRef<Points>(null)
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(3), 3))
    return g
  }, [])
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: glyphVertex,
        fragmentShader: glyphFragment,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uPx: rt.uniforms.uPx,
          uSize: { value: size },
          uShape: { value: CATEGORY_INDEX[category] },
          uFill: { value: filled ? 1 : 0 },
          uColor: { value: new Color() },
          uInk: { value: lin(palette.ink0) },
          uOpacity: { value: 0 },
        },
      }),
    [rt, size, category, filled],
  )
  useEffect(() => {
    ;(material.uniforms.uColor.value as Color).copy(toneColor(tone)).multiplyScalar(tone === 'signal' ? 1.25 : 1)
  }, [material, tone])
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  const p = useMemo(() => new Vector3(), [])
  useFrame((state, dt) => {
    const alt = track(p)
    const attr = geometry.attributes.position as BufferAttribute
    attr.setXYZ(0, p.x, p.y, p.z)
    attr.needsUpdate = true
    const visible = alt !== null && !occludedByEarth(state.camera.position, p)
    const u = material.uniforms.uOpacity
    const target = visible ? 1 : 0
    u.value += (target - u.value) * Math.min(1, dt / (rt.reducedMotion ? 0.05 : 0.12))
    if (points.current) points.current.visible = u.value > 0.004
  }, FRAME.scene)

  return <points ref={points} geometry={geometry} material={material} frustumCulled={false} renderOrder={6} />
}

/**
 * Project a tracked satellite to a screen anchor every frame (id: 'hover' | 'selected'). The anchor is removed
 * on unmount so the DOM callout disappears with the satellite.
 */
export function useSatAnchor(id: string, track: SatTrackFn) {
  const rt = useRuntime()
  const p = useMemo(() => new Vector3(), [])
  const ndc = useMemo(() => new Vector3(), [])
  useEffect(() => {
    rt.anchors.set(id, createAnchor())
    return () => {
      rt.anchors.delete(id)
    }
  }, [rt, id])
  useFrame((state) => {
    const a = rt.anchors.get(id)
    if (!a) return
    const alt = track(p)
    a.altKm = alt
    a.visible = alt !== null && !occludedByEarth(state.camera.position, p)
    if (!a.visible) return
    ndc.copy(p).project(state.camera)
    a.x = (ndc.x * 0.5 + 0.5) * state.size.width
    a.y = (-ndc.y * 0.5 + 0.5) * state.size.height
    // Near the top edge the box drops below the point (left/right placement is decided by the overlay).
    a.below = a.y < 110
    if (ndc.z > 1) a.visible = false
  }, FRAME.scene + 1)
}
