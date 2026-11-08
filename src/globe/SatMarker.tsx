/**
 * A single satellite, emphasised: its category glyph (DESIGN.md §2) drawn at its position, and a screen anchor
 * for its instrument-style callout (drawn by GlobeOverlay in the DOM). Both follow a `track` function evaluated
 * every frame, and hide when the satellite is behind the Earth. Callout placement (above / below, left / right,
 * hidden) is decided by the overlay from the measured box and the UI insets, not here.
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { BufferAttribute, BufferGeometry, Points, Vector3 } from 'three'
import type { SatCategory } from '@/types'
import { palette } from '@/ui/system/palette'
import { CATEGORY_INDEX } from './data'
import { createGlyphMaterial, lin } from './materials'
import { occludedByEarth } from './picking'
import { createAnchor, FRAME, useRuntime } from './runtime'

/** Writes the world position into `out`; returns the altitude in km, or null if unavailable right now. */
export type SatTrackFn = (out: Vector3) => number | null

export type MarkTone = 'signal' | 'bone' | 'ice'

const toneColor = (tone: MarkTone) => lin(tone === 'signal' ? palette.signal : tone === 'ice' ? palette.ice : palette.bone)

/**
 * Form follows DESIGN.md §2 (and Glyph.tsx glyphForCategory): only open-optical has a filled form (◆, "a real
 * image exists"); every other category keeps its outline form when it imaged the place and says so by colour.
 * `fade` (0..1, read every frame) multiplies the glyph's opacity, for the overlay's fade in / out.
 */
export function SatGlyph({
  category,
  imaged,
  tone,
  track,
  size = 13,
  fade,
}: {
  category: SatCategory
  imaged: boolean
  tone: MarkTone
  track: SatTrackFn
  size?: number
  fade?: RefObject<number>
}) {
  const rt = useRuntime()
  const filled = imaged && category === 'open-optical'
  const points = useRef<Points>(null)
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(3), 3))
    return g
  }, [])
  const material = useMemo(
    () => createGlyphMaterial(rt.uniforms.uPx, { size, shape: CATEGORY_INDEX[category], filled }),
    [rt, size, category, filled],
  )
  useEffect(() => {
    material.uniforms.uColor.value.copy(toneColor(tone)).multiplyScalar(tone === 'signal' ? 1.25 : 1)
  }, [material, tone])
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  const p = useMemo(() => new Vector3(), [])
  const vis = useRef(0)
  useFrame((state, dt) => {
    const alt = track(p)
    const attr = geometry.attributes.position as BufferAttribute
    attr.setXYZ(0, p.x, p.y, p.z)
    attr.needsUpdate = true
    const visible = alt !== null && !occludedByEarth(state.camera.position, p)
    const target = visible ? 1 : 0
    vis.current += (target - vis.current) * Math.min(1, dt / (rt.reducedMotion ? 0.05 : 0.12))
    const o = vis.current * (fade ? fade.current : 1)
    material.uniforms.uOpacity.value = o
    if (points.current) points.current.visible = o > 0.004
  }, FRAME.scene)

  return <points ref={points} geometry={geometry} material={material} frustumCulled={false} renderOrder={6} />
}

/**
 * Project a tracked satellite to a screen anchor every frame (ids: 'hover', 'sel:<passId>'). The anchor is
 * removed on unmount so the DOM callout fades with the satellite.
 */
export function useSatAnchor(id: string, track: SatTrackFn) {
  const rt = useRuntime()
  const p = useMemo(() => new Vector3(), [])
  const ndc = useMemo(() => new Vector3(), [])
  useEffect(() => {
    const a = createAnchor()
    rt.anchors.set(id, a)
    return () => {
      // Only remove our own anchor (a successor with the same id may already have replaced it).
      if (rt.anchors.get(id) === a) rt.anchors.delete(id)
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
    if (ndc.z > 1) a.visible = false
  }, FRAME.scene + 1)
}
