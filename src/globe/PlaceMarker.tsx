/**
 * The place reticle (DESIGN.md §6): a signal crosshair projected on the surface at store.place — thin ring,
 * four ticks, centre dot — plus a mono coordinate label (drawn by GlobeOverlay from the place anchor). It locks in
 * when the camera arrives (the ring contracts from 2× to 1× over 500 ms) and flares when a pass's swath sweeps
 * across the place.
 *
 * Motion is damped both ways (M11): when a new flight starts the ring eases back out to 2× over 240 ms (never a
 * one-frame jump); on reset or a new place the outgoing reticle stays mounted and fades out over 240 ms.
 *
 * Acquisition sequence (owner request C): while a live sequence runs toward the capture the reticle stays open
 * (2×), as if waiting; at the capture it locks (2× → 1×) and ONE shockwave ring expands from it (signal, 600 ms,
 * ease-out, fading).
 *
 * The quad lies in the tangent plane (so it foreshortens with the surface) and is rescaled every frame to a
 * constant on-screen size. It is drawn after the clouds with a polygon offset, so it stays readable above
 * the surface and the weather, while the planet still hides it on the far side.
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Matrix4, Mesh, PerspectiveCamera, PlaneGeometry, Vector3 } from 'three'
import { clamp, DEG, latLonToWorld } from '@/lib/geo'
import { easeInOut, easeOut } from '@/lib/ease'
import { useApp } from '@/state/store'
import { createReticleMaterial } from './materials'
import { createAnchor, FRAME, useRuntime } from './runtime'

/** Locked ring radius (CSS px) and the quad's half-size (room for the 2× ring and the capture shockwave). */
const RING_PX = 15
const HALF_PX = 124
const LOCK_MS = 500
const UNLOCK_MS = 240
const FADE_OUT_MS = 240
const FLASH_MS = 1100
/** The capture shockwave: one ring, out to SHOCK_SCALE × the ring radius over SHOCK_MS. */
const SHOCK_MS = 600
const LIFT = 1.0004

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

type PlaceRef = { key: string; lat: number; lon: number }
const keyOf = (p: { lat: number; lon: number }) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`
/** Anchor id of a place's coordinate label (GlobeOverlay reads the same id). */
export const placeAnchorId = (key: string) => `place:${key}`

export function PlaceMarker() {
  const place = useApp((st) => st.report?.place ?? st.place)
  // Mounted reticles: the current place plus any still fading out (derived during render).
  const [list, setList] = useState<PlaceRef[]>([])
  let next = list
  if (place) {
    const key = keyOf(place)
    if (!list.some((p) => p.key === key)) next = [...list, { key, lat: place.lat, lon: place.lon }]
  }
  if (next !== list) setList(next)
  return (
    <>
      {next.map((p) => (
        <Reticle key={p.key} id={p.key} lat={p.lat} lon={p.lon} onGone={() => setList((l) => l.filter((x) => x.key !== p.key))} />
      ))}
    </>
  )
}

function Reticle({ id, lat, lon, onGone }: { id: string; lat: number; lon: number; onGone: () => void }) {
  const rt = useRuntime()
  const mesh = useRef<Mesh>(null)

  const geometry = useMemo(() => new PlaneGeometry(1, 1), [])
  const material = useMemo(() => createReticleMaterial(rt.uniforms.uPx, RING_PX, HALF_PX * 2), [rt])
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

  const anim = useRef({
    born: performance.now(),
    /** Lock state: 'locking' from lockFrom, or 'unlocking' (ring easing back out to 2×) */
    lockFrom: -1,
    unlockFrom: -1,
    unlockStart: 0,
    lock: 0, // 0..1 eased lock amount actually shown
    openAt: -Infinity, // last frame the reticle was held open (flying, or a live acquisition before its capture)
    opacity: 0,
    leavingAt: -1,
    leaveFrom: 1,
    gone: false,
  })
  const tmp = useMemo(() => ({ v: new Vector3(), ndc: new Vector3() }), [])

  const anchorId = placeAnchorId(id)
  useEffect(() => {
    const a = createAnchor()
    rt.anchors.set(anchorId, a)
    return () => {
      if (rt.anchors.get(anchorId) === a) rt.anchors.delete(anchorId)
    }
  }, [rt, anchorId])

  useFrame((state, dt) => {
    const m = mesh.current
    if (!m) return
    const cam = state.camera as PerspectiveCamera
    const now = performance.now()
    const a = anim.current
    const u = material.uniforms
    const st = useApp.getState()
    const cur = st.report?.place ?? st.place
    const active = !!cur && keyOf(cur) === id

    // Constant on-screen size: world units per CSS px at the place's distance.
    const dist = tmp.v.copy(frame.pos).sub(cam.position).length()
    const worldPerPx = (2 * dist * Math.tan((cam.fov * DEG) / 2)) / Math.max(1, state.size.height)
    m.position.copy(frame.pos)
    m.quaternion.setFromRotationMatrix(frame.basis)
    m.scale.setScalar(HALF_PX * 2 * worldPerPx)

    // Lock-in when the camera arrives (or at once if it's already settled); a new flight eases the ring back out, and
    // so does a live acquisition until its capture.
    const acq = rt.acq
    const waiting = active && acq.armed && acq.passId !== '' && st.selectedPassId === acq.passId
    if (rt.camera.flying || waiting) {
      a.openAt = now
      if (a.lockFrom >= 0 || a.unlockFrom < 0) {
        a.unlockFrom = a.lock
        a.unlockStart = now
      }
      a.lockFrom = -1
      const k = rt.reducedMotion ? 1 : Math.min(1, (now - a.unlockStart) / UNLOCK_MS)
      a.lock = a.unlockFrom * (1 - easeInOut(k))
    } else {
      if (a.lockFrom < 0) a.lockFrom = Math.max(rt.camera.arrivedAt, a.born, a.openAt)
      a.unlockFrom = -1
      const t = rt.reducedMotion ? 1 : Math.min(1, Math.max(0, (now - a.lockFrom) / LOCK_MS))
      a.lock = Math.max(a.lock, easeOut(t))
    }
    u.uRing.value = RING_PX * (2 - a.lock)
    u.uLock.value = a.lock

    // Visibility: fade in on creation; dim while the camera is still on its way; fade out when replaced.
    if (!active && a.leavingAt < 0) {
      a.leavingAt = now
      a.leaveFrom = a.opacity
    }
    if (active && a.leavingAt >= 0) a.leavingAt = -1 // the same place came back
    if (a.leavingAt >= 0) {
      const k = Math.min(1, (now - a.leavingAt) / (rt.reducedMotion ? 120 : FADE_OUT_MS))
      a.opacity = a.leaveFrom * (1 - easeInOut(k))
      if (k >= 1 && !a.gone) {
        a.gone = true
        onGone()
      }
    } else {
      const target = rt.camera.flying && !waiting ? 0.55 : 1
      a.opacity += (target - a.opacity) * Math.min(1, dt / 0.25)
    }
    // Grazing angles: the quad is flat and a constant ~110 px wide, so near the limb its outer ring rises off
    // the curved surface and would poke past the horizon. Fade it out as the place turns edge-on (the same
    // threshold hides the coordinate label below).
    const facing = tmp.v.copy(cam.position).sub(frame.pos).normalize().dot(frame.d)
    u.uOpacity.value = a.opacity * smoothstep(0.06, 0.2, facing)

    // The capture: the ring flares and one shockwave runs out from it.
    const since = now - rt.flashAt
    if (active && since >= 0 && since < FLASH_MS) {
      const f = since / FLASH_MS
      u.uFlash.value = (1 - f) * (1 - f)
      u.uPulse.value = rt.reducedMotion || since >= SHOCK_MS ? 0 : Math.max(0.001, since / SHOCK_MS)
    } else {
      u.uFlash.value = 0
      u.uPulse.value = 0
    }

    // Coordinate label anchor: shown once locked, hidden when the place turns away or the reticle leaves.
    const anchor = rt.anchors.get(anchorId)
    if (anchor) {
      anchor.visible = active && facing > 0.15 && a.lock >= 0.999
      if (anchor.visible) {
        tmp.ndc.copy(frame.pos).project(cam)
        anchor.x = (tmp.ndc.x * 0.5 + 0.5) * state.size.width
        anchor.y = (-tmp.ndc.y * 0.5 + 0.5) * state.size.height
      }
    }
  }, FRAME.scene)

  return <mesh ref={mesh} geometry={geometry} material={material} renderOrder={5} frustumCulled={false} />
}
