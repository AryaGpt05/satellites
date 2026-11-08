/**
 * The place reticle (DESIGN.md §6): a signal crosshair projected on the surface at store.place — thin ring,
 * four ticks, centre dot — plus a mono coordinate label (drawn by GlobeOverlay from the place anchor). It locks in when the camera arrives (the ring
 * contracts from 2× to 1× over 500 ms) and flares when a pass's swath sweeps across the place.
 *
 * The quad lies in the tangent plane (so it foreshortens with the surface) and is rescaled every frame to a
 * constant on-screen size. It is drawn after the clouds with a polygon offset, so it stays readable above
 * the surface and the weather, while the planet still hides it on the far side.
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { Matrix4, Mesh, PerspectiveCamera, PlaneGeometry, ShaderMaterial, Vector3 } from 'three'
import { clamp, DEG, latLonToWorld } from '@/lib/geo'
import { useApp } from '@/state/store'
import { palette } from '@/ui/system/palette'
import { easeOut } from './cameraMath'
import { lin } from './Earth'
import { createAnchor, FRAME, useRuntime } from './runtime'
import { reticleFragment, reticleVertex } from './shaders/overlay'

/** Locked ring radius (CSS px) and the quad's half-size (room for the 2× ring and the flash pulse). */
const RING_PX = 15
const HALF_PX = 56
const LOCK_MS = 500
const FLASH_MS = 1100
const LIFT = 1.0004

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export function PlaceMarker() {
  const place = useApp((st) => st.report?.place ?? st.place)
  if (!place) return null
  return <Reticle key={`${place.lat.toFixed(5)},${place.lon.toFixed(5)}`} lat={place.lat} lon={place.lon} />
}

function Reticle({ lat, lon }: { lat: number; lon: number }) {
  const rt = useRuntime()
  const mesh = useRef<Mesh>(null)

  const geometry = useMemo(() => new PlaneGeometry(1, 1), [])
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: reticleVertex,
        fragmentShader: reticleFragment,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        uniforms: {
          uSizePx: { value: HALF_PX * 2 },
          uPx: rt.uniforms.uPx,
          uRing: { value: RING_PX * 2 },
          uRingBase: { value: RING_PX },
          uLock: { value: 0 },
          uFlash: { value: 0 },
          uPulse: { value: 0 },
          uColor: { value: lin(palette.signal).multiplyScalar(1.15) },
          uInk: { value: lin(palette.ink0) },
          uOpacity: { value: 0 },
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

  // Orientation: quad +X = east, +Y = north, +Z = up (surface normal).
  const frame = useMemo(() => {
    const d = latLonToWorld(lat, lon, 1)
    const east = new Vector3(d.z, 0, -d.x)
    if (east.lengthSq() < 1e-12) east.set(0, 0, -1)
    east.normalize()
    const north = new Vector3().crossVectors(d, east)
    const basis = new Matrix4().makeBasis(east, north, d)
    return { d, basis, pos: d.clone().multiplyScalar(LIFT) }
  }, [lat, lon])

  const anim = useRef({ born: performance.now(), lockFrom: -1, opacity: 0 })
  const tmp = useMemo(() => ({ v: new Vector3(), ndc: new Vector3() }), [])

  useEffect(() => {
    rt.anchors.set('place', createAnchor())
    return () => {
      rt.anchors.delete('place')
    }
  }, [rt])

  useFrame((state, dt) => {
    const m = mesh.current
    if (!m) return
    const cam = state.camera as PerspectiveCamera
    const now = performance.now()
    const a = anim.current
    const u = material.uniforms

    // Constant on-screen size: world units per CSS px at the place's distance.
    const dist = tmp.v.copy(frame.pos).sub(cam.position).length()
    const worldPerPx = (2 * dist * Math.tan((cam.fov * DEG) / 2)) / Math.max(1, state.size.height)
    m.position.copy(frame.pos)
    m.quaternion.setFromRotationMatrix(frame.basis)
    m.scale.setScalar(HALF_PX * 2 * worldPerPx)

    // Lock-in: starts when the camera arrives (or immediately if it's already settled).
    if (rt.camera.flying) a.lockFrom = -1
    else if (a.lockFrom < 0) a.lockFrom = Math.max(rt.camera.arrivedAt, a.born)
    const t = a.lockFrom < 0 ? 0 : rt.reducedMotion ? 1 : Math.min(1, (now - a.lockFrom) / LOCK_MS)
    const e = easeOut(t)
    u.uRing.value = RING_PX * (2 - e)
    u.uLock.value = e

    // Visibility: fade in on creation; dim while the camera is still on its way.
    const target = rt.camera.flying ? 0.55 : 1
    a.opacity += (target - a.opacity) * Math.min(1, dt / 0.25)
    // Grazing angles: the quad is flat and a constant ~110 px wide, so near the limb its outer ring rises off
    // the curved surface and would poke past the horizon. Fade it out as the place turns edge-on (the same
    // threshold hides the coordinate label below).
    const facing = tmp.v.copy(cam.position).sub(frame.pos).normalize().dot(frame.d)
    u.uOpacity.value = a.opacity * smoothstep(0.06, 0.2, facing)

    // Flash when the swath sweeps over the place.
    const since = now - rt.flashAt
    if (since >= 0 && since < FLASH_MS) {
      const f = since / FLASH_MS
      u.uFlash.value = (1 - f) * (1 - f)
      u.uPulse.value = rt.reducedMotion ? 0 : easeOut(Math.min(1, since / 900))
    } else {
      u.uFlash.value = 0
      u.uPulse.value = 0
    }

    // Coordinate label anchor: shown once locked, hidden when the place turns away from the camera.
    const anchor = rt.anchors.get('place')
    if (anchor) {
      anchor.visible = facing > 0.15 && t >= 1
      if (anchor.visible) {
        tmp.ndc.copy(frame.pos).project(cam)
        anchor.x = (tmp.ndc.x * 0.5 + 0.5) * state.size.width
        anchor.y = (-tmp.ndc.y * 0.5 + 0.5) * state.size.height
      }
    }
  }, FRAME.scene)

  return <mesh ref={mesh} geometry={geometry} material={material} renderOrder={5} frustumCulled={false} />
}
