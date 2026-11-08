/**
 * The whole catalog (~17k objects) as GPU points, propagated in the vertex shader from the engine's
 * ElementBuffer (Kepler + J2 secular; see shaders/chunks.ts KEPLER_J2 and src/engine/elements.ts).
 * The element buffer is bound zero-copy as three interleaved vec4 attributes.
 *
 * Hover: featured objects (~400 imagers, weather and crewed) are picked on the CPU from positions computed with
 * the engine's TS reference of the shader (refreshed at ~10 Hz), so the callout lands exactly on the point the
 * GPU drew. Mouse hover and touch tap both work; the globe writes store.hoveredNorad only for hovers it started.
 */
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute, ShaderMaterial, Vector2, Vector3 } from 'three'
import { useApp } from '@/state/store'
import { palette } from '@/ui/system/palette'
import { ELEMENT_STRIDE, FLAG_FEATURED, getSatInfo, keplerJ2World, propagate, type CatalogBuffers } from './data'
import { lin } from './Earth'
import { nearestWithin, projectPoints } from './picking'
import { FRAME, useRuntime } from './runtime'
import { SatGlyph, useSatAnchor, type MarkTone, type SatTrackFn } from './SatMarker'
import { satellitesFragment, satellitesVertex } from './shaders/points'

const PICK_RADIUS_MOUSE = 12
const PICK_RADIUS_TOUCH = 22
const CPU_REFRESH_MS = 100

export function SatelliteField({ data }: { data: CatalogBuffers }) {
  const rt = useRuntime()
  const gl = useThree((s) => s.gl)
  const { elements, indexOf } = data

  const { geometry, mark } = useMemo(() => {
    const g = new BufferGeometry()
    const buf = new InterleavedBuffer(elements.data, ELEMENT_STRIDE)
    // `position` only gives three a vertex count; the shader computes the real position.
    g.setAttribute('position', new InterleavedBufferAttribute(buf, 3, 0))
    g.setAttribute('aEl0', new InterleavedBufferAttribute(buf, 4, 0))
    g.setAttribute('aEl1', new InterleavedBufferAttribute(buf, 4, 4))
    g.setAttribute('aEl2', new InterleavedBufferAttribute(buf, 4, 8))
    const m = new BufferAttribute(new Float32Array(elements.count), 1)
    g.setAttribute('aMark', m)
    return { geometry: g, mark: m }
  }, [elements])

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: satellitesVertex,
        fragmentShader: satellitesFragment,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: { value: 0 },
          uGmst: { value: new Vector2(1, 0) },
          uPx: rt.uniforms.uPx,
          uHideA: { value: -1 },
          uHideB: { value: -1 },
          uShowAmbient: { value: 1 },
          uReveal: { value: 0 },
          uCamDist: { value: 5 },
          uBone: { value: lin(palette.bone) },
          uSignal: { value: lin(palette.signal) },
          uIce: { value: lin(palette.ice) },
        },
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

  // Satellites that imaged the place glow signal orange.
  useEffect(() => {
    const apply = (report = useApp.getState().report) => {
      const arr = mark.array as Float32Array
      arr.fill(0)
      for (const p of report?.passes ?? []) {
        if (p.verdict !== 'imaged') continue
        const i = indexOf.get(p.norad)
        if (i !== undefined) arr[i] = 1
      }
      mark.needsUpdate = true
    }
    apply()
    return useApp.subscribe((s, prev) => {
      if (s.report !== prev.report) apply(s.report)
    })
  }, [mark, indexOf])

  // ── featured objects for picking
  const featured = useMemo(() => {
    const idx: number[] = []
    for (let i = 0; i < elements.count; i++) {
      if ((elements.data[i * ELEMENT_STRIDE + 11] & FLAG_FEATURED) !== 0) idx.push(i)
    }
    return {
      index: Int32Array.from(idx),
      pos: new Float32Array(idx.length * 3),
      screen: new Float32Array(idx.length * 2),
      computedAt: -Infinity,
    }
  }, [elements])

  const pointer = useRef({ x: 0, y: 0, inside: false, moved: false, touch: false, buttons: 0, tapAt: -1, downX: 0, downY: 0 })
  const ownHover = useRef<number | undefined>(undefined)

  useEffect(() => {
    const el = gl.domElement
    const rect = () => el.getBoundingClientRect()
    const onMove = (e: PointerEvent) => {
      const r = rect()
      const p = pointer.current
      p.x = e.clientX - r.left
      p.y = e.clientY - r.top
      p.inside = true
      p.moved = true
      p.touch = e.pointerType !== 'mouse'
      p.buttons = e.buttons
    }
    const onLeave = () => {
      pointer.current.inside = false
      pointer.current.moved = true
    }
    const onDown = (e: PointerEvent) => {
      pointer.current.downX = e.clientX
      pointer.current.downY = e.clientY
    }
    const onUp = (e: PointerEvent) => {
      // A tap (no drag) on touch screens selects the nearest satellite for the callout.
      if (e.pointerType === 'mouse') return
      if (Math.hypot(e.clientX - pointer.current.downX, e.clientY - pointer.current.downY) > 8) return
      const r = rect()
      pointer.current.x = e.clientX - r.left
      pointer.current.y = e.clientY - r.top
      pointer.current.tapAt = performance.now()
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
    }
  }, [gl])

  const tmp = useMemo(() => new Vector3(), [])

  useFrame((state, dt) => {
    const u = material.uniforms
    const st = useApp.getState()
    u.uTime.value = (rt.simTime - elements.refEpochMs) / 1000
    ;(u.uGmst.value as Vector2).set(Math.cos(rt.gmst), Math.sin(rt.gmst))
    u.uCamDist.value = state.camera.position.length()
    u.uShowAmbient.value = st.showAmbient ? 1 : 0
    u.uHideA.value = rt.overlayNorad >= 0 ? (indexOf.get(rt.overlayNorad) ?? -1) : -1
    u.uHideB.value = st.hoveredNorad !== undefined ? (indexOf.get(st.hoveredNorad) ?? -1) : -1
    if (u.uReveal.value < 1) u.uReveal.value = Math.min(1, u.uReveal.value + dt / (rt.reducedMotion ? 0.2 : 1.4))

    // CPU positions of featured objects, ~10 Hz (and immediately after a big time jump).
    const now = performance.now()
    const jumped = Math.abs(rt.simTime - rt.prevSimTime) > 60_000
    if (now - featured.computedAt > CPU_REFRESH_MS || jumped) {
      featured.computedAt = now
      for (let k = 0; k < featured.index.length; k++) {
        keplerJ2World(elements, featured.index[k], rt.simTime, tmp)
        featured.pos[k * 3] = tmp.x
        featured.pos[k * 3 + 1] = tmp.y
        featured.pos[k * 3 + 2] = tmp.z
      }
    }

    // Picking: on pointer motion (mouse) or tap (touch), never while dragging the globe.
    const p = pointer.current
    const tapped = p.tapAt > 0 && now - p.tapAt < 300
    const dragging = p.buttons !== 0 && !tapped
    if ((p.moved && !p.touch) || tapped) {
      p.moved = false
      let hit = -1
      if (p.inside || tapped) {
        projectPoints(featured.pos, featured.index.length, state.camera, state.size.width, state.size.height, featured.screen)
        hit = nearestWithin(featured.screen, featured.index.length, p.x, p.y, tapped ? PICK_RADIUS_TOUCH : PICK_RADIUS_MOUSE)
      }
      if (tapped) p.tapAt = -1
      const norad = hit >= 0 && !dragging ? elements.norad[featured.index[hit]] : undefined
      if (norad !== undefined && norad !== st.hoveredNorad) {
        ownHover.current = norad
        st.setHoveredNorad(norad)
      } else if (norad === undefined && ownHover.current !== undefined && st.hoveredNorad === ownHover.current) {
        ownHover.current = undefined
        st.setHoveredNorad(undefined)
      }
    }
  }, FRAME.scene)

  const hovered = useApp((s) => s.hoveredNorad)
  const imaged = useApp((s) => (hovered !== undefined ? !!s.report?.passes.some((p) => p.norad === hovered && p.verdict === 'imaged') : false))
  const selectedNorad = useApp((s) => s.report?.passes.find((p) => p.id === s.selectedPassId)?.norad)

  return (
    <>
      <points geometry={geometry} material={material} frustumCulled={false} renderOrder={2} />
      {hovered !== undefined && hovered !== selectedNorad && indexOf.has(hovered) && (
        <HoveredSat key={hovered} norad={hovered} index={indexOf.get(hovered)!} data={data} imaged={imaged} />
      )}
    </>
  )
}

function HoveredSat({ norad, index, data, imaged }: { norad: number; index: number; data: CatalogBuffers; imaged: boolean }) {
  const rt = useRuntime()
  const info = getSatInfo(norad)
  // Position from the shader's reference math (so the mark sits exactly on the GPU point); the altitude
  // readout from SGP4 (geodetic, what a person means by altitude), refreshed at 4 Hz.
  const track: SatTrackFn = useMemo(() => {
    let altAt = -Infinity
    let alt: number | null = null
    return (out) => {
      keplerJ2World(data.elements, index, rt.simTime, out)
      if (Math.abs(rt.simTime - altAt) > 250) {
        altAt = rt.simTime
        alt = propagate(norad, rt.simTime)?.altKm ?? null
      }
      return alt
    }
  }, [data, index, norad, rt])
  const category = info?.category ?? 'other'
  const tone: MarkTone = imaged ? 'signal' : category === 'radar' ? 'ice' : 'bone'
  useSatAnchor('hover', track)
  return <SatGlyph category={category} filled={imaged} tone={tone} track={track} />
}
