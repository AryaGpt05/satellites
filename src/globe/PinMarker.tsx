/**
 * The dropped pin (store.pin): where "Search here" would search, picked on the globe itself (pin.ts has the gestures).
 *
 * Drawn with the place reticle's own shader (PlaceMarker.tsx) in bone, not signal: a pin is a proposal, the orange
 * reticle is a place that was searched. It drops in by closing from 2.2× onto its crosshair (280 ms, ease-out) and
 * fades out when cleared or when a search takes over the same spot (the place reticle then locks in where it was).
 * Like the place reticle it keeps a constant on-screen size, lies in the tangent plane and fades out edge-on.
 *
 * The pin's anchor ('pin') carries its screen position to the DOM card (PinOverlay.tsx). While a finger presses toward
 * a pin, `rt.pinPress` carries the press for the ring the card draws under it.
 *
 * Pins are dropped on the landing, the results and the error screen (never while a search is computing or About is
 * open), and cleared when a search starts.
 */
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Matrix4, Mesh, PerspectiveCamera, PlaneGeometry, Vector3 } from 'three'
import { clamp, DEG, latLonToWorld } from '@/lib/geo'
import { easeInOut, easeOut } from '@/lib/ease'
import { useApp, type AppState, type DroppedPin } from '@/state/store'
import { palette } from '@/ui/system/palette'
import { createReticleMaterial, lin } from './materials'
import { HOLD_MS, holdStill, isPinClick, pickSurface, roundPin, type PressStart } from './pin'
import { createAnchor, FRAME, useRuntime } from './runtime'

/** Ring radius once dropped (CSS px) and the quad's half-size: the place reticle's. */
const RING_PX = 15
const HALF_PX = 124
const DROP_MS = 280
const DROP_FROM = 2.2
const FADE_OUT_MS = 200
const LIFT = 1.0004
/** The pin's screen anchor (PinOverlay reads it). */
export const PIN_ANCHOR = 'pin'

const PIN_PHASES: AppState['phase'][] = ['idle', 'results', 'error']
const canPin = (st: AppState) => PIN_PHASES.includes(st.phase) && !st.aboutOpen

let pinIds = 0

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export function PinMarker() {
  usePinGestures()
  const pin = useApp((st) => st.pin)
  // The live pin plus any still fading out (derived during render, as PlaceMarker does).
  const [list, setList] = useState<DroppedPin[]>([])
  let next = list
  if (pin && !list.some((p) => p.id === pin.id)) next = [...list, pin]
  if (next !== list) setList(next)

  useEffect(() => {
    useApp.getState().setPinReady(true)
    // A search started (from the pin or anywhere else): its place reticle takes over; the pin goes.
    const off = useApp.subscribe((st, prev) => {
      if (st.pin && st.phase !== prev.phase && !canPin(st)) st.setPin(undefined)
    })
    return () => {
      off()
      useApp.getState().setPinReady(false)
    }
  }, [])

  return (
    <>
      {next.map((p) => (
        <PinReticle key={p.id} pin={p} onGone={() => setList((l) => l.filter((x) => x.id !== p.id))} />
      ))}
    </>
  )
}

/** Click (mouse) or press-and-hold (touch, pen) on the planet drops the pin; a click on space clears it. */
function usePinGestures() {
  const rt = useRuntime()
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    const el = gl.domElement
    const pointers = new Set<number>()
    /** The press under way; `lx`, `ly` where the finger is now (it may wobble a few px while it holds) */
    let press: (PressStart & { id: number; lx: number; ly: number }) | null = null
    let timer = 0
    const endPress = () => {
      window.clearTimeout(timer)
      press = null
      rt.pinPress.at = -1
    }
    // The canvas' box, kept current by a ResizeObserver (the hover check runs on every mouse move: no layout read there).
    let rect = el.getBoundingClientRect()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => (rect = el.getBoundingClientRect()))
    ro?.observe(el)
    const onResize = () => (rect = el.getBoundingClientRect())
    window.addEventListener('resize', onResize)
    const ndcOf = (clientX: number, clientY: number) =>
      rect.width && rect.height ? { x: ((clientX - rect.left) / rect.width) * 2 - 1, y: -((clientY - rect.top) / rect.height) * 2 + 1 } : null
    /** Drop (or move) the pin under client point (x, y); true if it landed on the planet. */
    const dropAt = (clientX: number, clientY: number): boolean => {
      const n = ndcOf(clientX, clientY)
      const hit = n && pickSurface(n.x, n.y, camera)
      if (!hit) return false
      useApp.getState().setPin({ id: ++pinIds, lat: roundPin(hit.lat), lon: roundPin(hit.lon), via: 'globe' })
      return true
    }
    // The landing's "Drop a pin" chip: a pin at the middle of the planet's disc as it is on screen.
    const offChip = useApp.subscribe((st, prev) => {
      if (st.pinAtCentre === prev.pinAtCentre || !canPin(st)) return
      const c = new Vector3(0, 0, 0).project(camera)
      const hit = pickSurface(c.x, c.y, camera)
      if (hit) st.setPin({ id: ++pinIds, lat: roundPin(hit.lat), lon: roundPin(hit.lon), via: 'chip' })
    })
    // Desktop: a crosshair over the planet says it can take a pin (the default arrow over space).
    let cursor = ''
    const onHover = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.buttons) return
      const n = ndcOf(e.clientX, e.clientY)
      const want = n && canPin(useApp.getState()) && pickSurface(n.x, n.y, camera) ? 'crosshair' : ''
      if (want !== cursor) el.style.cursor = cursor = want
    }
    const onDown = (e: PointerEvent) => {
      pointers.add(e.pointerId)
      if (pointers.size > 1 || !canPin(useApp.getState())) return endPress()
      press = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        at: performance.now(),
        pointerType: e.pointerType,
        button: e.button,
        modifier: e.shiftKey || e.ctrlKey || e.metaKey || e.altKey,
        lx: e.clientX,
        ly: e.clientY,
      }
      rt.pinPress.dropped = false
      if (e.pointerType === 'mouse') return
      rt.pinPress.x = e.clientX - rect.left
      rt.pinPress.y = e.clientY - rect.top
      rt.pinPress.at = press.at
      const p = press
      timer = window.setTimeout(() => {
        if (press !== p) return
        if (!canPin(useApp.getState())) return endPress()
        // Under the finger as it is now: a wobble within the slop pans the globe a little too.
        if (dropAt(p.lx, p.ly)) {
          rt.pinPress.dropped = true
          navigator.vibrate?.(8)
        }
        press = null
        rt.pinPress.at = -1
      }, HOLD_MS)
    }
    const onMove = (e: PointerEvent) => {
      if (!press || press.id !== e.pointerId || press.pointerType === 'mouse') return
      if (!holdStill(press, e.clientX, e.clientY)) return endPress()
      press.lx = e.clientX
      press.ly = e.clientY
    }
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      const p = press
      if (!p || p.id !== e.pointerId) return
      endPress()
      if (!isPinClick(p, e.clientX, e.clientY, performance.now()) || !canPin(useApp.getState())) return
      // A click on space clears the pin; on the planet it drops one there.
      if (!dropAt(e.clientX, e.clientY)) useApp.getState().setPin(undefined)
    }
    const onCancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      if (press?.id === e.pointerId) endPress()
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointermove', onHover)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    // The wheel and a second finger are camera moves, never a hold.
    el.addEventListener('wheel', endPress, { passive: true })
    return () => {
      endPress()
      offChip()
      ro?.disconnect()
      window.removeEventListener('resize', onResize)
      el.style.cursor = ''
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointermove', onHover)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      el.removeEventListener('wheel', endPress)
    }
  }, [gl, camera, rt])
}

function PinReticle({ pin, onGone }: { pin: DroppedPin; onGone: () => void }) {
  const rt = useRuntime()
  const mesh = useRef<Mesh>(null)
  const geometry = useMemo(() => new PlaneGeometry(1, 1), [])
  const material = useMemo(() => {
    const m = createReticleMaterial(rt.uniforms.uPx, RING_PX, HALF_PX * 2)
    m.uniforms.uColor.value = lin(palette.bone)
    return m
  }, [rt])
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  // Orientation: quad +X = east, +Y = north, +Z = up (surface normal), as PlaceMarker.
  const frame = useMemo(() => {
    const d = latLonToWorld(pin.lat, pin.lon, 1)
    const east = new Vector3(d.z, 0, -d.x)
    if (east.lengthSq() < 1e-12) east.set(0, 0, -1)
    east.normalize()
    const north = new Vector3().crossVectors(d, east)
    return { d, basis: new Matrix4().makeBasis(east, north, d), pos: d.clone().multiplyScalar(LIFT) }
  }, [pin.lat, pin.lon])

  const anim = useRef({ born: performance.now(), leavingAt: -1, leaveFrom: 1, opacity: 0, gone: false })
  const tmp = useMemo(() => ({ v: new Vector3(), ndc: new Vector3() }), [])

  useEffect(() => {
    const a = createAnchor()
    rt.anchors.set(PIN_ANCHOR, a)
    return () => {
      if (rt.anchors.get(PIN_ANCHOR) === a) rt.anchors.delete(PIN_ANCHOR)
    }
    // One anchor per live pin: a newer pin replaces it (its effect runs after this one's cleanup or later).
  }, [rt, pin.id])

  useFrame((state) => {
    const m = mesh.current
    if (!m) return
    const cam = state.camera as PerspectiveCamera
    const now = performance.now()
    const a = anim.current
    const u = material.uniforms
    const live = useApp.getState().pin?.id === pin.id

    const dist = tmp.v.copy(frame.pos).sub(cam.position).length()
    const worldPerPx = (2 * dist * Math.tan((cam.fov * DEG) / 2)) / Math.max(1, state.size.height)
    m.position.copy(frame.pos)
    m.quaternion.setFromRotationMatrix(frame.basis)
    m.scale.setScalar(HALF_PX * 2 * worldPerPx)

    // Drop: the ring closes onto the crosshair; the ticks come in with it.
    const k = rt.reducedMotion ? 1 : Math.min(1, (now - a.born) / DROP_MS)
    const lock = easeOut(k)
    u.uRing.value = RING_PX * (DROP_FROM - (DROP_FROM - 1) * lock)
    u.uLock.value = lock

    if (!live && a.leavingAt < 0) {
      a.leavingAt = now
      a.leaveFrom = a.opacity
    }
    if (a.leavingAt >= 0) {
      const f = Math.min(1, (now - a.leavingAt) / (rt.reducedMotion ? 100 : FADE_OUT_MS))
      a.opacity = a.leaveFrom * (1 - easeInOut(f))
      if (f >= 1 && !a.gone) {
        a.gone = true
        onGone()
      }
    } else a.opacity = rt.reducedMotion ? 1 : Math.min(1, (now - a.born) / 120)
    const facing = tmp.v.copy(cam.position).sub(frame.pos).normalize().dot(frame.d)
    u.uOpacity.value = a.opacity * smoothstep(0.06, 0.2, facing)

    const anchor = live ? rt.anchors.get(PIN_ANCHOR) : undefined
    if (anchor) {
      anchor.visible = facing > 0.15
      if (anchor.visible) {
        tmp.ndc.copy(frame.pos).project(cam)
        anchor.x = (tmp.ndc.x * 0.5 + 0.5) * state.size.width
        anchor.y = (-tmp.ndc.y * 0.5 + 0.5) * state.size.height
      }
    }
  }, FRAME.scene)

  return <mesh ref={mesh} geometry={geometry} material={material} renderOrder={5} frustumCulled={false} />
}
