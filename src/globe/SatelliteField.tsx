/**
 * The whole catalog (~17k objects) as GPU points, propagated in the vertex shader from the engine's
 * ElementBuffer (Kepler + J2 secular; see shaders/chunks.ts KEPLER_J2 and src/engine/elements.ts).
 * The element buffer is bound zero-copy as three interleaved vec4 attributes.
 *
 * Hover: featured objects (~400 imagers, weather and crewed) are picked on the CPU from positions computed with
 * the engine's TS reference of the shader (refreshed at ~10 Hz), so the callout lands exactly on the point the
 * GPU drew. Mouse hover and touch tap both work; the globe writes store.hoveredNorad only for hovers it started.
 *
 * Time jumps (a pass selected / deselected moves sim time by days, M04): the cloud would teleport. Instead it
 * keeps its pre-jump time while it dims to 15% over 200 ms, takes the new time while dim, stays dim for the
 * camera flight, and returns over 480 ms after arrival.
 */
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Sphere,
  Vector2,
  Vector3,
  type PerspectiveCamera,
} from 'three'
import { DEG, gmst } from '@/lib/geo'
import { easeInOut, easeOut } from '@/lib/ease'
import { useApp } from '@/state/store'
import { ELEMENT_STRIDE, FLAG_FEATURED, getSatInfo, keplerJ2World, propagate, type CatalogBuffers } from './data'
import { createSatellitesMaterial } from './materials'
import { nearestWithin, projectPoints } from './picking'
import { HOLD_MS } from './pin'
import { FRAME, useRuntime } from './runtime'
import { SatGlyph, useSatAnchor, type MarkTone, type SatTrackFn } from './SatMarker'

/** Jump dip: dim level, how fast it dims, and how it returns after the camera arrives. */
const DIP_LEVEL = 0.15
const DIP_DOWN_MS = 200
const DIP_UP_MS = 480

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
    // The `position` attribute holds orbital elements, not positions: give three a fixed bound (everything up
    // to well past GEO) instead of letting it scan 17k "points" on the first frame.
    g.boundingSphere = new Sphere(new Vector3(), 50)
    return { geometry: g, mark: m }
  }, [elements])

  const material = useMemo(() => createSatellitesMaterial(rt.uniforms.uPx), [rt])
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

  const pointer = useRef({ x: 0, y: 0, inside: false, moved: false, touch: false, buttons: 0, tapAt: -1, downX: 0, downY: 0, downAt: 0 })
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
      pointer.current.downAt = performance.now()
    }
    const onUp = (e: PointerEvent) => {
      // A tap (no drag) on touch screens selects the nearest satellite for the callout.
      if (e.pointerType === 'mouse') return
      if (Math.hypot(e.clientX - pointer.current.downX, e.clientY - pointer.current.downY) > 8) return
      // A press held long enough to drop a pin (PinMarker) is not also a satellite pick.
      if (performance.now() - pointer.current.downAt >= HOLD_MS) return
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
  /** Entrance reveal (0 → 1 once) and the jump dip, multiplied into uReveal. */
  const fx = useRef({
    reveal: 0,
    jumpSeen: rt.timeJump.id,
    dip: 1,
    phase: 'none' as 'none' | 'down' | 'hold' | 'up',
    from: 1,
    at: 0,
    /** Sim time the field keeps drawing while it dims (wall-clock advanced), or NaN */
    heldTime: NaN,
    heldAt: 0,
  })

  useFrame((state, dt) => {
    const u = material.uniforms
    const st = useApp.getState()
    const now = performance.now()
    const f = fx.current
    f.reveal = Math.min(1, f.reveal + dt / (rt.reducedMotion ? 0.2 : 1.4))
    // ── jump dip (only when a camera flight carries the jump: a scrub or seek keeps the points live)
    if (rt.timeJump.id !== f.jumpSeen) {
      f.jumpSeen = rt.timeJump.id
      if (!rt.reducedMotion && rt.camera.flying) {
        f.phase = 'down'
        f.from = f.dip
        f.at = now
        if (Number.isNaN(f.heldTime)) {
          f.heldTime = rt.timeJump.fromSimTime
          f.heldAt = now
        }
      }
    }
    if (f.phase === 'down') {
      const k = Math.min(1, (now - f.at) / DIP_DOWN_MS)
      f.dip = f.from + (DIP_LEVEL - f.from) * easeInOut(k)
      if (k >= 1) {
        f.phase = 'hold'
        f.heldTime = NaN // take the new time while dim
      }
    } else if (f.phase === 'hold') {
      f.dip = DIP_LEVEL
      if (!rt.camera.flying && now >= rt.camera.arrivedAt) {
        f.phase = 'up'
        f.at = Math.max(now, rt.camera.arrivedAt)
      }
    } else if (f.phase === 'up') {
      if (rt.camera.flying) f.phase = 'hold'
      const k = Math.min(1, (now - f.at) / DIP_UP_MS)
      f.dip = DIP_LEVEL + (1 - DIP_LEVEL) * easeOut(k)
      if (k >= 1) f.phase = 'none'
    } else f.dip = 1
    u.uReveal.value = f.reveal * f.dip
    // While dimming, keep drawing the pre-jump instant (advancing at live rate) so nothing teleports at full alpha.
    const drawTime = Number.isNaN(f.heldTime) ? rt.simTime : f.heldTime + (now - f.heldAt)
    u.uTime.value = (drawTime - elements.refEpochMs) / 1000
    const gm = Number.isNaN(f.heldTime) ? rt.gmst : gmst(drawTime)
    ;(u.uGmst.value as Vector2).set(Math.cos(gm), Math.sin(gm))
    const camDist = state.camera.position.length()
    u.uCamDist.value = camDist
    // Apparent angular radius ρ of the unit sphere (sin ρ = 1/D), in CSS px of the vertical field of view.
    const fov = (state.camera as PerspectiveCamera).fov ?? 30
    const rho = Math.asin(Math.min(1, 1 / Math.max(camDist, 1.0001)))
    u.uEarthPx.value = (Math.tan(rho) / Math.tan((fov * DEG) / 2)) * (state.size.height / 2)
    u.uShowAmbient.value = st.showAmbient ? 1 : 0
    u.uHideA.value = rt.overlayNorad >= 0 ? (indexOf.get(rt.overlayNorad) ?? -1) : -1
    u.uHideB.value = st.hoveredNorad !== undefined ? (indexOf.get(st.hoveredNorad) ?? -1) : -1

    // CPU positions of featured objects, ~10 Hz (and immediately after a big time jump).
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
  return <SatGlyph category={category} imaged={imaged} tone={tone} track={track} />
}
