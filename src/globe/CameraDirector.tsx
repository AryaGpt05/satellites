/**
 * Drives the camera from store.camera intents.
 *
 *  - New intent → a cinematic flight (2.4–3.6 s, --ease-in-out) from wherever the camera is, interpolating
 *    the look-at point along the great circle, range in log space and the facing by parallel transport (see
 *    cameraMath.ts): target and distance always move together, never a linear lerp, never a pole flip.
 *  - prefers-reduced-motion → cut, with a 300 ms fade from ink.
 *  - overview: slow westward drift of the camera (the planet appears to turn eastward), north-up.
 *  - satellite: the target moves; the flight homes in on it and the camera then rides along.
 *  - In idle / results the user can orbit and zoom (controls.ts); input interrupts a flight cleanly, and auto
 *    rotation resumes a few seconds after the last touch.
 * Lens shift composes the subject off-centre without changing perspective.
 */
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { Mesh, PerspectiveCamera, PlaneGeometry, ShaderMaterial, Vector3 } from 'three'
import { bearingDeg, clamp, DEG, EARTH_RADIUS_KM, subsolarPoint } from '@/lib/geo'
import { selectSelectedPass, useApp, type AppState, type CameraIntent } from '@/state/store'
import { palette } from '@/ui/system/palette'
import {
  copyPose,
  createPose,
  damp,
  easeInOut,
  eastNorth,
  interpolatePose,
  latLonOfDir,
  makePose,
  orthonormalize,
  planFlight,
  poseToCamera,
  rotateAbout,
  signedAngle,
  type PoseSpec,
} from './cameraMath'
import { applyControls, attachControls, createControlInput, createControlState } from './controls'
import { fovFor, isPhone, overviewPose, passPose, placePose, satellitePose, type Viewport } from './framing'
import { propagate } from './data'
import { FRAME, useRuntime } from './runtime'
import { lin } from './Earth'

/** Overview drift: degrees of longitude per second (one turn every 10 minutes). */
const DRIFT_DEG_S = 0.6
/** Auto-rotation resumes this long after the last user input, ramping in over RAMP_S. */
const RESUME_AFTER_MS = 5000
const RAMP_S = 2.5
/** Reduced-motion cut fade. */
const CUT_FADE_MS = 300

const INTERACTIVE: AppState['phase'][] = ['idle', 'locating', 'results', 'error']

interface Flight {
  start: number
  duration: number
  bump: number
}

function intentKey(intent: CameraIntent, st: AppState, phone: boolean): string {
  const layout = phone ? 'p' : 'd'
  switch (intent.kind) {
    case 'overview':
      return `overview|${layout}`
    case 'place':
      return `place:${intent.lat.toFixed(5)},${intent.lon.toFixed(5)}|${layout}`
    case 'pass': {
      const found = st.report?.passes.some((p) => p.id === intent.passId) ? 1 : 0
      return `pass:${intent.passId}:${found}|${layout}`
    }
    case 'satellite':
      return `sat:${intent.norad}|${layout}`
  }
}

/** Satellite sub-point + heading at a time, from main-thread SGP4. */
function satNow(norad: number, ms: number) {
  const a = propagate(norad, ms)
  const b = propagate(norad, ms + 2000)
  if (!a) return null
  const heading = b ? bearingDeg(a, b) : 0
  return { lat: a.lat, lon: a.lon, altKm: a.altKm, heading }
}

/**
 * Target pose spec for an intent, or null if it can't be resolved yet (e.g. the pass isn't in the report).
 * `overviewAt` provides the look-at for overview (continuity with wherever the camera is).
 */
function targetFor(
  intent: CameraIntent,
  st: AppState,
  vp: Viewport,
  simTime: number,
  overviewAt: { lat: number; lon: number },
): PoseSpec | null {
  switch (intent.kind) {
    case 'overview':
      return overviewPose(vp, overviewAt.lat, overviewAt.lon)
    case 'place':
      return placePose(vp, intent.lat, intent.lon)
    case 'pass': {
      const pass = st.report?.passes.find((p) => p.id === intent.passId) ?? selectSelectedPass(st)
      const place = st.report?.place ?? st.place
      if (pass && place) return passPose(vp, pass, place)
      return place ? placePose(vp, place.lat, place.lon) : null
    }
    case 'satellite': {
      const s = satNow(intent.norad, simTime)
      return s ? satellitePose(vp, s, s.heading) : null
    }
  }
}

const fadeVertex = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`
const fadeFragment = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha;
  void main() { gl_FragColor = vec4(uColor, uAlpha);
  #include <colorspace_fragment>
  }`

export function CameraDirector() {
  const rt = useRuntime()
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const gl = useThree((s) => s.gl)

  const st = useRef({
    pose: createPose(),
    from: createPose(),
    target: createPose(),
    flight: null as Flight | null,
    key: '',
    initialized: false,
    userTouched: false,
    gestureSeen: 0,
    drift: 0, // 0..1 ramp of the overview drift
  })
  const input = useMemo(createControlInput, [])
  const control = useMemo(createControlState, [])

  // Pointer / wheel controls on the canvas.
  useEffect(() => {
    const el = gl.domElement
    el.style.touchAction = 'none'
    return attachControls(el, input, () => INTERACTIVE.includes(useApp.getState().phase))
  }, [gl, input])

  // Full-screen fade quad for reduced-motion cuts.
  const fade = useMemo(() => {
    const geometry = new PlaneGeometry(2, 2)
    const material = new ShaderMaterial({
      vertexShader: fadeVertex,
      fragmentShader: fadeFragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: { uColor: { value: lin(palette.ink0) }, uAlpha: { value: 0 } },
    })
    return { geometry, material }
  }, [])
  useEffect(
    () => () => {
      fade.geometry.dispose()
      fade.material.dispose()
    },
    [fade],
  )

  const fadeMesh = useRef<Mesh>(null)
  const tmp = useMemo(() => ({ pos: new Vector3(), up: new Vector3(), target: new Vector3(), e: new Vector3(), n: new Vector3() }), [])

  useFrame((state, dtRaw) => {
    const s = st.current
    const dt = Math.min(dtRaw, 0.1)
    const now = performance.now()
    const store = useApp.getState()
    const vp: Viewport = { width: state.size.width, height: state.size.height }
    const phone = isPhone(vp)
    const fov = fovFor(vp)
    const intent = store.camera

    // Overview look-at: at boot, put the sun ~45° east of centre so the day side faces right and the
    // terminator (and city lights) sit near the left limb; later, keep the camera's current longitude.
    let overviewAt: { lat: number; lon: number }
    if (!s.initialized) {
      const sun = subsolarPoint(rt.simTime)
      overviewAt = { lat: 22, lon: sun.lon - 45 }
    } else {
      const ll = latLonOfDir(s.pose.d)
      overviewAt = { lat: clamp(ll.lat, -30, 38) * 0.4 + 22 * 0.6, lon: ll.lon }
    }

    const key = intentKey(intent, store, phone)
    const spec = targetFor(intent, store, vp, rt.simTime, overviewAt)

    if (!s.initialized && spec) {
      makePose(spec, s.pose)
      makePose(spec, s.target)
      s.initialized = true
      s.key = key
      rt.camera.arrivedAt = now
    } else if (key !== s.key && spec) {
      // New intent: fly (or cut).
      s.key = key
      makePose(spec, s.target)
      s.userTouched = false
      control.spin.set(0, 0, 0)
      control.zoomTarget = null
      rt.camera.flightId++
      if (rt.reducedMotion) {
        copyPose(s.target, s.pose)
        s.flight = null
        rt.cutAt = now
        rt.camera.arrivedAt = now
      } else {
        copyPose(s.pose, s.from)
        const plan = planFlight(s.from, s.target)
        s.flight = { start: now, duration: plan.duration, bump: plan.bump }
        rt.camera.arrivedAt = -Infinity
      }
      s.drift = 0
    } else if (spec && intent.kind === 'satellite') {
      // Moving target: keep the destination current.
      makePose(spec, s.target)
    } else if (spec && !s.flight && !s.userTouched && intent.kind !== 'overview') {
      // Settled and untouched: follow layout changes (resize, rotation) smoothly.
      makePose(spec, s.target)
    }

    // A new gesture interrupts a running flight right where it is.
    if (input.gestureId !== s.gestureSeen) {
      s.gestureSeen = input.gestureId
      if (s.flight) {
        s.flight = null
        rt.camera.arrivedAt = now
      }
      s.userTouched = true
    }

    if (s.flight) {
      const t = clamp((now - s.flight.start) / (s.flight.duration * 1000), 0, 1)
      interpolatePose(s.from, s.target, easeInOut(t), s.flight.bump, s.pose)
      if (t >= 1) {
        s.flight = null
        rt.camera.arrivedAt = now
      }
    } else {
      const moved = applyControls(s.pose, input, control, dt, fov, vp.height, intent.kind === 'overview')
      if (moved) s.userTouched = true

      if (intent.kind === 'overview') {
        // North-up: ease the facing back to north.
        eastNorth(s.pose.d, tmp.e, tmp.n)
        const a = signedAngle(s.pose.fwd, tmp.n, s.pose.d)
        rotateAbout(s.pose.fwd, s.pose.d, a * damp(dt, 0.4), s.pose.fwd)
        // Drift, resuming after the user lets go.
        const idleFor = now - input.lastInputAt
        const want = !rt.reducedMotion && !input.dragging && idleFor > RESUME_AFTER_MS ? 1 : 0
        s.drift = clamp(s.drift + (want ? dt / RAMP_S : -dt / 0.3), 0, 1)
        if (s.drift > 0) {
          const ease = s.drift * s.drift * (3 - 2 * s.drift)
          rotateAbout(s.pose.d, tmp.up.set(0, 1, 0), -DRIFT_DEG_S * DEG * dt * ease, s.pose.d)
          rotateAbout(s.pose.fwd, tmp.up, -DRIFT_DEG_S * DEG * dt * ease, s.pose.fwd)
        }
        // Composition (range, lens shift) follows the layout unless the user zoomed.
        if (spec) {
          const k = damp(dt, 0.6)
          if (!s.userTouched) s.pose.range += (spec.range - s.pose.range) * k
          s.pose.shiftX += ((spec.shiftX ?? 0) - s.pose.shiftX) * k
          s.pose.shiftY += ((spec.shiftY ?? 0) - s.pose.shiftY) * k
          s.pose.tilt += (0 - s.pose.tilt) * (s.userTouched ? 0 : k)
        }
      } else if (intent.kind === 'satellite' && spec) {
        // Ride along: the look-at point follows the satellite; user zoom / tilt are kept.
        const k = damp(dt, 0.15)
        s.pose.d.lerp(s.target.d, k).normalize()
        s.pose.fwd.lerp(s.target.fwd, k)
        s.pose.r += (s.target.r - s.pose.r) * k
        if (!s.userTouched) {
          s.pose.range += (s.target.range - s.pose.range) * k
          s.pose.tilt += (s.target.tilt - s.pose.tilt) * k
        }
        s.pose.shiftX += (s.target.shiftX - s.pose.shiftX) * k
        s.pose.shiftY += (s.target.shiftY - s.pose.shiftY) * k
        orthonormalize(s.pose)
      } else if (!s.userTouched) {
        const k = damp(dt, 0.5)
        s.pose.range += (s.target.range - s.pose.range) * k
        s.pose.shiftX += (s.target.shiftX - s.pose.shiftX) * k
        s.pose.shiftY += (s.target.shiftY - s.pose.shiftY) * k
      } else {
        // Keep the composition's lens shift even after the user moved.
        const k = damp(dt, 0.5)
        s.pose.shiftX += (s.target.shiftX - s.pose.shiftX) * k
        s.pose.shiftY += (s.target.shiftY - s.pose.shiftY) * k
      }
    }

    // ── apply to the camera
    poseToCamera(s.pose, tmp.pos, tmp.up, tmp.target)
    camera.position.copy(tmp.pos)
    camera.up.copy(tmp.up)
    camera.lookAt(tmp.target)
    const alt = tmp.pos.length() - 1
    camera.fov = fov
    camera.aspect = vp.width / Math.max(1, vp.height)
    camera.near = clamp(alt * 0.3, 0.0005, 0.8)
    camera.far = 400
    camera.updateProjectionMatrix()
    // Lens shift: the look-at point lands at NDC (shiftX, shiftY).
    camera.projectionMatrix.elements[8] = -s.pose.shiftX
    camera.projectionMatrix.elements[9] = -s.pose.shiftY
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
    camera.updateMatrixWorld()

    rt.camera.flying = s.flight !== null
    rt.camera.altitudeKm = alt * EARTH_RADIUS_KM

    // Reduced-motion cut fade.
    const since = now - rt.cutAt
    const fadeAlpha = since < CUT_FADE_MS ? 1 - since / CUT_FADE_MS : 0
    fade.material.uniforms.uAlpha.value = fadeAlpha
    if (fadeMesh.current) fadeMesh.current.visible = fadeAlpha > 0
  }, FRAME.camera)

  return (
    <mesh
      ref={fadeMesh}
      geometry={fade.geometry}
      material={fade.material}
      frustumCulled={false}
      renderOrder={1000}
      visible={false}
    />
  )
}
