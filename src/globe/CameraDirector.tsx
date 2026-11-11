/**
 * Drives the camera from store.camera intents, framed around the UI that is actually on screen.
 *
 *  - New intent → a cinematic flight (2.4–3.6 s, --ease-in-out) from wherever the camera is, interpolating
 *    the look-at point along the great circle, range in log space and the facing by parallel transport (see
 *    cameraMath.ts): target and distance always move together, never a linear lerp, never a pole flip.
 *    Tilting into an oblique view happens over the flight's second half (no yaw: every pose is north-up).
 *  - A new intent DURING a flight (a pass tapped on arrival, a share link's preselect, ←/→) is a retarget: the
 *    new flight starts at the camera's current speed and eases out (easeCarry), so it never brakes mid-air.
 *  - prefers-reduced-motion → cut, with a 300 ms fade from ink.
 *  - Framing follows store.uiInsets (framing.ts). Lens shift tracks the free rect every frame (τ 0.12 s, so the
 *    globe glides with a dragged sheet). Outside a flight, range changes wait until the insets have been still
 *    for 150 ms, then move over 600 ms (--ease-in-out). DURING a flight, a new range (an inset change, a sharper
 *    texture's floor) folds into the flight at once: a log-range correction eased over the rest of the flight
 *    (velocity-continuous across repeated changes), so the camera makes ONE move and lands framed, with no pop
 *    and no second move after arrival.
 *  - The near limit follows the loaded day texture (framing.minRangeFor, decision 6), for poses and user zoom.
 *    When a sharper map lands while parked the floor relaxes and the view comes in with a slower focus move
 *    (0.9–1.9 s).
 *  - The camera is `manual` for R3F: its projection (aspect from the live viewport, lens shift) is applied here
 *    every frame, so an adaptive-DPR step or a resize never renders a frame without the shift.
 *  - overview: slow westward drift of the camera (the planet appears to turn eastward), north-up; as the boot
 *    curtain lifts, one damped focus dolly (G15).
 *  - pass, acquisition sequence (owner request C, acquisition.ts): while a fresh replay runs toward closest
 *    approach the target is the CHASE pose (framing.chasePose: oblique, north-up, halfway between the spacecraft
 *    and the place), recomputed every frame from the spacecraft's SGP4 position, and the camera follows it exactly
 *    once it has arrived; as the scan line closes on the place the chase DIVES onto it (acquisition.diveAt), so the
 *    image paints large. A replay started on the pass already in view flies to the chase first. At the capture the
 *    camera settles (a soft 1.2 s ease that does not hold the replay clock) into the resting view: for an imaged
 *    pass the near-top-down ACQUIRED view of the image painted onto the globe (framing.acquiredPose), otherwise the
 *    oblique pass view. Quiet selections (no replay) go straight to the resting view. A gesture ends the chase.
 *  - In idle / results the user can orbit and zoom (controls.ts); input interrupts a flight cleanly, and auto
 *    rotation resumes a few seconds after the last touch.
 *  - Publishes flight status to store.cameraFlight on transitions only (start, arrival, cut, interrupt), and
 *    rt.camera.{flying, progress, arrivedAt} every frame for the scene.
 * Target specs are recomputed only when their inputs change (intent, report, viewport, insets, texture level).
 */
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Mesh, PerspectiveCamera, PlaneGeometry, Vector3 } from 'three'
import { bearingDeg, clamp, DEG, EARTH_RADIUS_KM, latLonToWorld, subsolarPoint } from '@/lib/geo'
import { easeInOut, easeOut } from '@/lib/ease'
import { selectSelectedPass, useApp, type AppState, type CameraIntent, type UiInsets } from '@/state/store'
import {
  applyPoseToCamera,
  copyPose,
  createPose,
  curveAt,
  curveSlope,
  damp,
  dirFromLatLon,
  carrySpeed,
  easeCarry,
  eastNorth,
  interpolatePose,
  latLonOfDir,
  makeCurve,
  makePose,
  orthonormalize,
  planFlight,
  rotateAbout,
  signedAngle,
  tiltProgress,
  type PoseSpec,
  type RangeCurve,
} from './cameraMath'
import { applyControls, attachControls, createControlInput, createControlState } from './controls'
import { propagate } from './data'
import { diveAt, geoDiveAt, type AcqState } from './acquisition'
import {
  acquiredPose,
  chasePose,
  geoScanPose,
  coarserLevel,
  fovFor,
  freeRect,
  TOOLBAR_SLACK_PX,
  trackStableHeight,
  type StableHeight,
  isPhone,
  minRangeFor,
  overviewPose,
  passPose,
  placePose,
  satellitePose,
  type TextureLevel,
  type Viewport,
} from './framing'
import { createFadeMaterial } from './materials'
import { FRAME, useRuntime, type GlobeRuntime } from './runtime'

/** Overview drift: degrees of longitude per second (one turn every 10 minutes). */
const DRIFT_DEG_S = 0.6
/** Auto-rotation resumes this long after the last user input, ramping in over RAMP_S. */
const RESUME_AFTER_MS = 5000
const RAMP_S = 2.5
/** Reduced-motion cut fade. */
const CUT_FADE_MS = 300
/** Lens-shift follow time constant (s): fast enough to track a dragged sheet. */
const SHIFT_TAU = 0.12
/** Insets must be still this long before the range re-frames, over RANGE_MOVE_MS. */
const INSETS_SETTLE_MS = 150
const RANGE_MOVE_MS = 600
/**
 * A sharper texture arriving relaxes the zoom floor, which can bring a place view in by 2× or more (a deep link
 * frames the place at the 1k floor while the finer maps wait for the upload gate). That unprompted move must
 * read as a deliberate focus, not a lurch: it runs slower, longer for bigger steps.
 */
const RANGE_FOCUS_MS = { min: 900, perLog: 1100, max: 1900 }
/** Boot focus dolly: start this much further out, settle over BOOT_DOLLY_S with --ease-out. */
const BOOT_DOLLY_SCALE = 1.12
const BOOT_DOLLY_S = 2.4
/** Retargets keep at least this duration (s) and run at 80% of a fresh flight's. */
const RETARGET_MIN_S = 1.8
/** A range folded into a flight eases over the rest of it, but never faster than this (ms). */
const FOLD_MIN_MS = 300
/** Acquisition: the chase keeps following this long after the capture, then settles over SETTLE_S (owner: ≈ 1.2 s). */
const CAPTURE_HOLD_MS = 220
const SETTLE_S = 1.2
/**
 * A new pass whose resting view is (nearly) the one on screen (swiping between photos of the same place) is not a
 * flight: the camera re-frames softly over SAME_VIEW_S and reports arrival at once (no ring unlock, no clock hold).
 * Each photo's view centres on its own image data (acquisition.imageFocus: up to ~20 km off the place), so two
 * photos of one place can sit ~40 km apart: still the same view.
 */
const SAME_VIEW = { rad: 0.008, logRange: 0.12, tilt: 0.05 }
const SAME_VIEW_S = 0.6

const INTERACTIVE: AppState['phase'][] = ['idle', 'locating', 'results', 'error']

interface Flight {
  id: number
  start: number
  /** seconds */
  duration: number
  bump: number
  ease: (t: number) => number
  /** The boot focus dolly: range is a fixed factor of the LIVE target, so a late re-frame rescales it */
  dolly?: boolean
  /** A composition move within the same intent (the acquisition settle): it neither holds the replay clock nor
   *  counts as a flight for the scene, the texture gate or store.cameraFlight */
  soft?: boolean
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

/**
 * Quantised insets (24 px steps) packed into one number: a change re-frames the range; it is never mistaken for
 * a new intent. Allocation-free, as it runs every frame.
 */
const insetsKeyOf = (i: UiInsets) =>
  ((Math.round(i.top / 24) * 512 + Math.round(i.right / 24)) * 512 + Math.round(i.bottom / 24)) * 512 + Math.round(i.left / 24)

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
 * `overviewAt` provides the look-at for overview (continuity with wherever the camera is); `floor` is the
 * texture-resolution near limit.
 */
const _sat = new Vector3()
const _focus = { lat: 0, lon: 0 }
/** The acquired view's centre (the painted image's data, acquisition.imageFocus), else the place. No allocation. */
function focusOf(acq: AcqState, place: { lat: number; lon: number }) {
  if (!acq.focusOk) return place
  _focus.lat = acq.focusLat
  _focus.lon = acq.focusLon
  return _focus
}

function targetFor(
  intent: CameraIntent,
  st: AppState,
  vp: Viewport,
  insets: UiInsets,
  floor: number,
  simTime: number,
  overviewAt: { lat: number; lon: number },
  acq: AcqState,
  chasing: boolean,
  stableHeight?: number,
): PoseSpec | null {
  switch (intent.kind) {
    case 'overview':
      return overviewPose(vp, insets, overviewAt.lat, overviewAt.lon, stableHeight)
    case 'place':
      return placePose(vp, insets, intent.lat, intent.lon, floor)
    case 'pass': {
      const pass = st.report?.passes.find((p) => p.id === intent.passId) ?? selectSelectedPass(st)
      const place = st.report?.place ?? st.place
      if (pass && place && acq.passId === pass.id) {
        if (chasing) {
          const sat = propagate(pass.norad, simTime)
          // A geostationary scan: the satellite stays put, so the camera stands behind it and then dives to the place.
          if (sat && pass.geostationary)
            return geoScanPose(vp, insets, latLonToWorld(sat.lat, sat.lon, 1 + sat.altKm / EARTH_RADIUS_KM, _sat), place, geoDiveAt(simTime, acq.tc), acq.halfKm, focusOf(acq, place))
          if (sat) {
            const dive = diveAt(simTime, acq.tc, acq.speedKmS, acq.halfKm)
            return chasePose(vp, insets, latLonToWorld(sat.lat, sat.lon, 1 + sat.altKm / EARTH_RADIUS_KM, _sat), place, dive, acq.halfKm, focusOf(acq, place))
          }
        }
        if (acq.imaged) return acquiredPose(vp, insets, focusOf(acq, place), acq.halfKm)
      }
      if (pass && place) return passPose(vp, insets, pass, place, floor)
      return place ? placePose(vp, insets, place.lat, place.lon, floor) : null
    }
    case 'satellite': {
      const s = satNow(intent.norad, simTime)
      return s ? satellitePose(vp, insets, s, s.heading) : null
    }
  }
}

/** Publish arrival / cut / interrupt (transitions only). */
function arrive(rt: GlobeRuntime, id: number, now: number, kind: CameraIntent['kind']) {
  rt.camera.arrivedAt = now
  rt.camera.arrivedKind = kind
  rt.camera.progress = 1
  useApp.getState().setCameraFlight({ id, flying: false, eta: now, arrivedAt: now })
}

/** Range moves and folds, for probe scripts (dev and inspect builds only; compiled out of production). */
function logRange(kind: 'move' | 'fold' | 'settle', now: number, from: number, to: number, dur: number) {
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'inspect') return
  const w = window as unknown as { __rangeLog?: unknown[] }
  ;(w.__rangeLog ??= []).push({ kind, t: Math.round(now), from: +from.toFixed(4), to: +to.toFixed(4), dur: Math.round(dur) })
}

/**
 * A flight ended (arrival, or a gesture took over): its range correction becomes the target range. A correction
 * that started within FOLD_MIN_MS of arrival finishes as a range move on the same curve (same value and slope).
 */
function settleFold(s: { fold: RangeCurve | null; rangeMove: RangeCurve | null; target: { range: number } }, now: number) {
  const fd = s.fold
  if (!fd) return
  s.fold = null
  const base = Math.log(s.target.range)
  s.target.range = Math.exp(base + fd.l1)
  if (now < fd.start + fd.dur) {
    s.rangeMove = makeCurve(base + curveAt(fd, now), base + fd.l1, curveSlope(fd, now), now, fd.start + fd.dur - now)
    s.target.range = Math.exp(s.rangeMove.l0)
    logRange('settle', now, s.target.range, Math.exp(base + fd.l1), s.rangeMove.dur)
  }
}

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
    held: false, // a pin or a tapped satellite held the drift last frame
    // Inputs of the current target spec (recompute only when one changes).
    spec: null as PoseSpec | null,
    intent: null as CameraIntent | null,
    report: undefined as AppState['report'],
    vpW: 0,
    vpH: 0,
    level: '' as TextureLevel | '',
    insetsKey: -1,
    insetsAt: 0,
    rangeDirty: false,
    /** Range re-frame in progress outside a flight: s.target.range follows it (log-space) */
    rangeMove: null as RangeCurve | null,
    /**
     * Range folded into the running flight: a log-range CORRECTION on top of the flight's own interpolation (whose
     * end range stays s.target.range), reaching l1 = log(new range / s.target.range) by arrival.
     */
    fold: null as RangeCurve | null,
    /** Lens shift the target follows (smoothed) */
    shiftX: 0,
    shiftY: 0,
    // Velocity estimate (visual), for carrying speed across retargets.
    prevD: new Vector3(1, 0, 0),
    prevRange: 1,
    velPan: 0, // rad/s of the look-at point
    velDir: new Vector3(), // unit tangent of that motion
    velZoom: 0, // d(log range)/dt
    bootDolly: 'pending' as 'pending' | 'armed' | 'done',
    /** Acquisition: the armedAt last seen (a new one = a fresh replay), whether the chase ran last frame, and a
     *  chase flight owed to a replay started on the pass already in view */
    armedSeen: -Infinity,
    chasing: false,
    chaseFlight: false,
    /** The phone overview's toolbar-stable height (framing.trackStableHeight) */
    stable: null as StableHeight | null,
  })
  const input = useMemo(createControlInput, [])
  const control = useMemo(createControlState, [])
  const vp = useMemo<Viewport>(() => ({ width: 1, height: 1 }), [])

  // The projection is ours (applyPoseToCamera, every frame): R3F must not reset it on a DPR step or a resize, or
  // that frame would render without the lens shift.
  useLayoutEffect(() => {
    ;(camera as PerspectiveCamera & { manual?: boolean }).manual = true
  }, [camera])

  // Pointer / wheel controls on the canvas.
  useEffect(() => {
    const el = gl.domElement
    el.style.touchAction = 'none'
    return attachControls(el, input, () => INTERACTIVE.includes(useApp.getState().phase))
  }, [gl, input])

  // Full-screen fade quad for reduced-motion cuts.
  const fade = useMemo(() => ({ geometry: new PlaneGeometry(2, 2), material: createFadeMaterial() }), [])
  useEffect(
    () => () => {
      fade.geometry.dispose()
      fade.material.dispose()
    },
    [fade],
  )

  const fadeMesh = useRef<Mesh>(null)
  const tmp = useMemo(
    () => ({
      e: new Vector3(),
      n: new Vector3(),
      axis: new Vector3(),
      free: { x0: 0, y0: 0, x1: 0, y1: 0 },
      chaseInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      sub: new Vector3(),
      cam: { pos: new Vector3(), up: new Vector3(), target: new Vector3() },
    }),
    [],
  )

  useFrame((state, dtRaw) => {
    const s = st.current
    const dt = Math.min(dtRaw, 0.1)
    const now = performance.now()
    const store = useApp.getState()
    vp.width = state.size.width
    vp.height = state.size.height
    const phone = isPhone(vp)
    const fov = fovFor(vp)
    const tanHalf = Math.tan((fov * DEG) / 2)
    const intent = store.camera
    let insets = store.uiInsets
    // Near limit: the map actually on screen at the look-at point (the night map on the night side).
    const sub = intent.kind === 'place' ? dirFromLatLon(intent.lat, intent.lon, tmp.sub) : s.initialized ? s.target.d : null
    const lit = !sub || sub.dot(rt.sunDir) > 0.1
    const level = lit ? rt.textureLevel : coarserLevel(rt.textureLevel, rt.nightLevel)
    const floor = minRangeFor(vp, level)

    // ── acquisition: chase while a fresh replay runs toward the capture (and a beat after it).
    const acq = rt.acq
    const acqPass = intent.kind === 'pass' && intent.passId === acq.passId
    if (acqPass && acq.armed && acq.armedAt !== s.armedSeen) {
      s.armedSeen = acq.armedAt
      s.userTouched = false // a replay is a request to watch
      s.chaseFlight = true
    }
    const chasing =
      acqPass && !rt.reducedMotion && !s.userTouched && (acq.armed || (s.chasing && now < acq.capturedAt + CAPTURE_HOLD_MS))
    const chaseEnded = s.chasing && !chasing
    // The chase frames below the acquisition countdown (GlobeOverlay AcqReadout, under the HUD band), so the
    // spacecraft never flies behind it (a phone's short globe band especially).
    if (chasing && rt.readoutBottom > insets.top) {
      const c = tmp.chaseInsets
      c.top = rt.readoutBottom
      c.right = insets.right
      c.bottom = insets.bottom
      c.left = insets.left
      insets = c
    }

    // ── target spec: recomputed only when an input changed (G13).
    const ik = insetsKeyOf(insets)
    if (ik !== s.insetsKey) {
      s.insetsKey = ik
      s.insetsAt = now
      s.rangeDirty = true
    }
    const vpChanged = vp.width !== s.vpW || vp.height !== s.vpH
    // Browser chrome (toolbars on scroll): the same width, a small height change. The overview keeps its framing.
    const chromeOnly = vpChanged && vp.width === s.vpW && Math.abs(vp.height - s.vpH) < TOOLBAR_SLACK_PX
    s.stable = trackStableHeight(s.stable, vp.width, vp.height)
    // During a flight an inset change re-frames at once: it folds into the landing (no settle wait).
    const settledInsets = s.rangeDirty && (s.flight !== null || now - s.insetsAt >= INSETS_SETTLE_MS)
    const recompute =
      !s.spec ||
      intent !== s.intent ||
      store.report !== s.report ||
      vpChanged ||
      level !== s.level ||
      settledInsets ||
      intent.kind === 'satellite' ||
      chasing ||
      chaseEnded
    let key = s.key
    if (recompute) {
      // Overview look-at: at boot, put the sun ~45° east of centre so the day side faces right and the terminator
      // (and city lights) sit near the left limb; later, keep the camera's current longitude.
      let overviewAt: { lat: number; lon: number }
      if (!s.initialized) {
        const sun = subsolarPoint(rt.simTime)
        overviewAt = { lat: 22, lon: sun.lon - 45 }
      } else {
        const ll = latLonOfDir(s.pose.d)
        overviewAt = { lat: clamp(ll.lat, -30, 38) * 0.4 + 22 * 0.6, lon: ll.lon }
      }
      const spec = targetFor(intent, store, vp, insets, floor, rt.simTime, overviewAt, acq, chasing, phone ? s.stable.height : undefined)
      // Only the texture level changed (no layout change): the slower focus move below.
      const focusOnly = level !== s.level && !settledInsets && !vpChanged && intent === s.intent
      s.intent = intent
      s.report = store.report
      s.vpW = vp.width
      s.vpH = vp.height
      s.level = level
      if (settledInsets) s.rangeDirty = false
      // A spec that can't resolve yet (the pass isn't in the report) keeps the current target and intent; the
      // report landing triggers the next recompute.
      if (spec) {
        s.spec = spec
        key = intentKey(intent, store, phone)
      }
      // Re-framing of the same intent: range moves smoothly (the shift is tracked below, every frame). The chase and
      // its settle move the whole pose instead (below).
      if (spec && s.initialized && key === s.key && intent.kind !== 'satellite' && !chasing && !chaseEnded) {
        const to = spec.range
        const curTo = s.rangeMove ? Math.exp(s.rangeMove.l1) : s.fold ? s.target.range * Math.exp(s.fold.l1) : s.target.range
        const dl = Math.abs(Math.log(to / curTo))
        if (dl > 0.004) {
          if (s.flight && !s.flight.dolly) {
            // Fold into the running flight: it lands at the new range, in one move.
            const f = s.flight
            const c0 = s.fold ? curveAt(s.fold, now) : 0
            const v0 = s.fold ? curveSlope(s.fold, now) : 0
            const dur = Math.max(FOLD_MIN_MS, f.start + f.duration * 1000 - now)
            s.fold = makeCurve(c0, Math.log(to / s.target.range), v0, now, dur)
            logRange('fold', now, s.target.range * Math.exp(c0), to, dur)
          } else {
            const dur = focusOnly ? clamp(RANGE_FOCUS_MS.min + RANGE_FOCUS_MS.perLog * dl, RANGE_FOCUS_MS.min, RANGE_FOCUS_MS.max) : RANGE_MOVE_MS
            const l0 = Math.log(s.target.range)
            s.rangeMove = makeCurve(l0, Math.log(to), s.rangeMove ? curveSlope(s.rangeMove, now) : 0, now, dur)
            logRange('move', now, s.target.range, to, dur)
          }
        }
        // Overview look-at continuity: only the composition changes, never the look-at.
        s.target.tilt = spec.tilt ?? 0
      }
      // Toolbars collapsing or showing: the globe holds its place in CSS px at once (the canvas grew or shrank at the
      // bottom; easing the lens shift would slide it), and the range above did not move (stable band).
      if (spec && chromeOnly && intent.kind === 'overview' && s.initialized) {
        s.shiftX = spec.shiftX ?? 0
        s.shiftY = spec.shiftY ?? 0
      }
    }
    const spec = s.spec

    // Lens shift wanted right now: the exact free rect (no quantisation) for subjects; the overview spec's own.
    let wantX = spec?.shiftX ?? 0
    let wantY = spec?.shiftY ?? 0
    if (intent.kind !== 'overview') {
      const f = freeRect(vp, insets, tmp.free)
      wantX = (f.x0 + f.x1) / Math.max(1, vp.width) - 1
      wantY = 1 - (f.y0 + f.y1) / Math.max(1, vp.height)
    }

    /** Fly (or cut) from the pose on screen to s.target: a new intent, or a replay's chase on the pass in view. */
    function startFlight(retarget: boolean) {
      s.chaseFlight = false
      const id = ++rt.camera.flightId
      if (rt.reducedMotion) {
        copyPose(s.target, s.pose)
        s.flight = null
        rt.cutAt = now
        arrive(rt, id, now, intent.kind)
        return
      }
      copyPose(s.pose, s.from)
      const plan = planFlight(s.from, s.target)
      let duration = plan.duration
      let ease = easeInOut
      if (retarget) {
        duration = Math.max(RETARGET_MIN_S, plan.duration * 0.8)
        // Carry the current visual speed along the new path.
        ease = easeCarry(carrySpeed(s.from, s.target, { pan: s.velPan, dir: s.velDir, zoom: s.velZoom }, tanHalf, duration))
      }
      s.flight = { id, start: now, duration, bump: plan.bump, ease }
      rt.camera.arrivedAt = -Infinity
      rt.camera.progress = 0
      store.setCameraFlight({ id, flying: true, eta: now + duration * 1000, arrivedAt: -1 })
    }

    if (!s.initialized && spec) {
      makePose(spec, s.pose)
      makePose(spec, s.target)
      s.shiftX = s.target.shiftX
      s.shiftY = s.target.shiftY
      s.initialized = true
      s.key = key
      rt.camera.arrivedAt = now
      rt.camera.arrivedKind = intent.kind
      rt.camera.progress = 1
      // G15: start a touch further out while the boot curtain is up; the dolly settles as it lifts.
      if (store.phase === 'boot' && intent.kind === 'overview' && !rt.reducedMotion) {
        s.pose.range *= BOOT_DOLLY_SCALE
        s.bootDolly = 'armed'
      } else s.bootDolly = 'done'
      s.prevD.copy(s.pose.d)
      s.prevRange = s.pose.range
    } else if (key !== s.key && spec) {
      // New intent: fly (or cut). A flight already under way is a retarget (a soft settle is not).
      const retarget = s.flight !== null && !s.flight.soft
      s.key = key
      makePose(spec, s.target)
      s.shiftX = s.target.shiftX
      s.shiftY = s.target.shiftY
      s.rangeMove = null
      s.fold = null // the new flight starts from the pose on screen, correction included
      s.userTouched = false
      control.spin.set(0, 0, 0)
      control.zoomTarget = null
      s.bootDolly = 'done'
      const sameView =
        !retarget &&
        !chasing &&
        !rt.reducedMotion &&
        intent.kind === 'pass' &&
        s.pose.d.angleTo(s.target.d) < SAME_VIEW.rad &&
        Math.abs(Math.log(s.target.range / s.pose.range)) < SAME_VIEW.logRange &&
        Math.abs(s.target.tilt - s.pose.tilt) < SAME_VIEW.tilt &&
        Math.abs(s.target.r - s.pose.r) < 1e-3
      if (sameView) {
        copyPose(s.pose, s.from)
        s.flight = { id: rt.camera.flightId, start: now, duration: SAME_VIEW_S, bump: 0, ease: easeInOut, soft: true }
        arrive(rt, ++rt.camera.flightId, now, intent.kind)
      } else startFlight(retarget)
      s.drift = 0
    } else if (spec && intent.kind === 'satellite') {
      // Moving target: keep the destination current.
      makePose(spec, s.target)
    } else if (spec && chasing) {
      // The chase target moves with the spacecraft (held still while the camera flies: the replay clock waits).
      makePose(spec, s.target)
      s.target.shiftX = s.shiftX
      s.target.shiftY = s.shiftY
      if (s.chaseFlight && !s.flight) {
        // A replay started on the pass already in view: fly to the chase first (the clock holds meanwhile).
        startFlight(false)
      }
    } else if (spec && chaseEnded && !s.userTouched && !s.flight) {
      // The capture: settle into the resting view (soft: the replay clock keeps running, the image keeps painting).
      makePose(spec, s.target)
      s.target.shiftX = s.shiftX
      s.target.shiftY = s.shiftY
      s.rangeMove = null
      s.fold = null
      copyPose(s.pose, s.from)
      s.flight = { id: rt.camera.flightId, start: now, duration: rt.reducedMotion ? 0.001 : SETTLE_S, bump: 0, ease: easeInOut, soft: true }
    }
    s.chaseFlight = s.chaseFlight && chasing && !s.flight
    s.chasing = chasing

    // G15: the one focus dolly as the boot curtain lifts (not for URL targets or share boots).
    if (s.bootDolly === 'armed' && store.phase !== 'boot') {
      s.bootDolly = 'done'
      if (store.phase === 'idle' && intent.kind === 'overview' && !s.flight && !rt.reducedMotion) {
        // Frame for the landing that is mounting right now (its insets may be newer than the settle delay), and
        // re-seat the start 12% further out while the curtain still covers the globe: a pure dolly-in.
        const ll = latLonOfDir(s.pose.d)
        const now0 = overviewPose(vp, insets, ll.lat, ll.lon)
        s.spec = now0
        s.target.range = now0.range
        s.target.shiftX = s.shiftX = now0.shiftX ?? 0
        s.target.shiftY = s.shiftY = now0.shiftY ?? 0
        s.rangeMove = null
        s.fold = null
        s.rangeDirty = false
        s.pose.range = now0.range * BOOT_DOLLY_SCALE
        s.pose.shiftX = s.target.shiftX
        s.pose.shiftY = s.target.shiftY
        copyPose(s.pose, s.from)
        s.target.d.copy(s.pose.d)
        s.target.fwd.copy(s.pose.fwd)
        s.drift = 0 // the drift ramps in after the dolly
        const id = ++rt.camera.flightId
        s.flight = { id, start: now, duration: BOOT_DOLLY_S, bump: 0, ease: easeOut, dolly: true }
        rt.camera.arrivedAt = -Infinity
        rt.camera.progress = 0
        store.setCameraFlight({ id, flying: true, eta: now + BOOT_DOLLY_S * 1000, arrivedAt: -1 })
      }
    }

    // ── framing follows the UI: shift every frame (smoothed), range by a timed move.
    if (intent.kind !== 'satellite') {
      const k = damp(dt, SHIFT_TAU)
      s.shiftX += (wantX - s.shiftX) * k
      s.shiftY += (wantY - s.shiftY) * k
      s.target.shiftX = s.shiftX
      s.target.shiftY = s.shiftY
      if (s.rangeMove) {
        const m = s.rangeMove
        const done = rt.reducedMotion || now >= m.start + m.dur
        s.target.range = Math.exp(done ? m.l1 : curveAt(m, now))
        if (done) s.rangeMove = null
      }
    }

    // A new gesture interrupts a running flight right where it is.
    if (input.gestureId !== s.gestureSeen) {
      s.gestureSeen = input.gestureId
      if (s.flight) {
        const { id, soft } = s.flight
        s.flight = null
        settleFold(s, now)
        if (!soft) arrive(rt, id, now, intent.kind)
      }
      s.userTouched = true
    }

    if (s.flight) {
      const f = s.flight
      const t = clamp((now - f.start) / (f.duration * 1000), 0, 1)
      const e = f.ease(t)
      interpolatePose(s.from, s.target, e, f.bump, s.pose, tiltProgress(e, s.from.tilt, s.target.tilt))
      if (f.dolly) s.pose.range = s.target.range * (1 + (BOOT_DOLLY_SCALE - 1) * (1 - e))
      else if (s.fold) s.pose.range *= Math.exp(curveAt(s.fold, now))
      if (!f.soft) rt.camera.progress = e
      if (t >= 1) {
        s.flight = null
        settleFold(s, now)
        if (!f.soft) arrive(rt, f.id, now, intent.kind)
      }
    } else {
      // The acquired view may sit inside the base map's floor (the painted image carries the detail): zoom keeps it.
      const zoomFloor = acqPass && acq.imaged && s.spec ? Math.min(floor, s.spec.range * 0.7) : floor
      const moved = applyControls(s.pose, input, control, dt, fov, vp.height, intent.kind === 'overview', s.pose.r > 1.0001 ? 0 : zoomFloor)
      if (moved) s.userTouched = true

      if (intent.kind === 'overview') {
        // North-up: ease the facing back to north.
        eastNorth(s.pose.d, tmp.e, tmp.n)
        const a = signedAngle(s.pose.fwd, tmp.n, s.pose.d)
        rotateAbout(s.pose.fwd, s.pose.d, a * damp(dt, 0.4), s.pose.fwd)
        // Drift, resuming after the user lets go.
        // A dropped pin, or a satellite picked by a tap, holds the planet still (it must not drift away from its card or
        // callout while someone reads it). Clicking off it lets the drift ease back in at once, not 5 s later.
        const held = !!store.pin || rt.tapPicked
        if (s.held && !held) input.lastInputAt = Math.min(input.lastInputAt, now - RESUME_AFTER_MS)
        s.held = held
        const idleFor = now - input.lastInputAt
        const want = !rt.reducedMotion && !input.dragging && idleFor > RESUME_AFTER_MS && s.bootDolly !== 'armed' && !held ? 1 : 0
        s.drift = clamp(s.drift + (want ? dt / RAMP_S : -dt / 0.3), 0, 1)
        if (s.drift > 0) {
          const ease = s.drift * s.drift * (3 - 2 * s.drift)
          tmp.axis.set(0, 1, 0)
          rotateAbout(s.pose.d, tmp.axis, -DRIFT_DEG_S * DEG * dt * ease, s.pose.d)
          rotateAbout(s.pose.fwd, tmp.axis, -DRIFT_DEG_S * DEG * dt * ease, s.pose.fwd)
        }
        // Composition (range, lens shift) follows the layout unless the user zoomed (held out while the boot
        // dolly waits for the curtain).
        if (!s.userTouched) s.pose.range = s.target.range * (s.bootDolly === 'armed' ? BOOT_DOLLY_SCALE : 1)
        s.pose.shiftX = s.target.shiftX
        s.pose.shiftY = s.target.shiftY
        s.pose.tilt += (0 - s.pose.tilt) * (s.userTouched ? 0 : damp(dt, 0.6))
      } else if (intent.kind === 'satellite') {
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
      } else if (chasing) {
        // Chasing the spacecraft: the pose IS the (smoothly moving) target.
        copyPose(s.target, s.pose)
      } else {
        // Settled on a place or pass: the composition follows the (already smoothed) target; user zoom is kept.
        if (!s.userTouched) s.pose.range = s.target.range
        s.pose.shiftX = s.target.shiftX
        s.pose.shiftY = s.target.shiftY
      }
    }

    // ── apply to the camera
    const alt = applyPoseToCamera(s.pose, camera, vp, fov, tmp.cam)
    rt.camera.flying = s.flight !== null && !s.flight.soft
    rt.camera.altitudeKm = alt * EARTH_RADIUS_KM
    rt.camera.kmPerPx = (s.pose.range * EARTH_RADIUS_KM * tanHalf) / Math.max(1, vp.height / 2)
    rt.inputAt = input.dragging ? now : input.lastInputAt

    // ── velocity estimate (smoothed over a few frames) for retargets
    if (dt > 1e-4) {
      const ang = s.prevD.angleTo(s.pose.d)
      const w = Math.min(1, dt / 0.04)
      s.velPan += (ang / dt - s.velPan) * w
      if (ang > 1e-9) {
        tmp.axis.copy(s.pose.d).sub(s.prevD)
        tmp.axis.addScaledVector(s.pose.d, -tmp.axis.dot(s.pose.d)).normalize()
        s.velDir.lerp(tmp.axis, w).normalize()
      }
      s.velZoom += (Math.log(s.pose.range / s.prevRange) / dt - s.velZoom) * w
      s.prevD.copy(s.pose.d)
      s.prevRange = s.pose.range
    }

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
