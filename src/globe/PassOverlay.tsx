/**
 * The selected pass (store.report + store.selectedPassId), replay-synced to sim time:
 *  - swath ribbon on the surface (width = profile swath, or the field-of-regard ground range for agile imagers),
 *    built from real great-circle offsets perpendicular to the heading (swath.ts) and clipped to ±700 km
 *    along-track around the place. It reads as a SWEEP: a 1 px front line with a short glow crosses the place as
 *    replay time advances, the fill fades behind it, the edges are bone ahead and the verdict colour behind;
 *  - the satellite at simTime from main-thread SGP4, placed geodetically (latLonToWorld(lat, lon, 1 + h/R)) so it
 *    sits exactly above its own track, drawn as its category glyph with a callout;
 *  - a nadir line to the ground, a fading orbit trail behind it, and for pointable imagers a view line to the
 *    place while the place is within its field of regard;
 *  - when the front crosses the place on an 'imaged' pass, the reticle flashes.
 * Colour follows meaning: signal only where an image exists or is likely; agile "could have" passes are bone
 * (radar: ice) with a dashed field of regard; crewed passes draw the track alone.
 *
 * Entrances and exits are damped (M11): a pass fades in over 500 ms (--ease-out); on deselect, ←/→ or reset the
 * outgoing pass stays mounted, frozen at its last sim time, and fades out over 300 ms (--ease-in-out).
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BufferAttribute, BufferGeometry, Mesh, Vector2, Vector3 } from 'three'
import { EARTH_RADIUS_KM, latLonToWorld } from '@/lib/geo'
import { easeInOut, easeOut } from '@/lib/ease'
import { selectSelectedPass, useApp } from '@/state/store'
import type { Pass, SatCategory } from '@/types'
import { palette } from '@/ui/system/palette'
import { getSatInfo, groundTrack, propagate } from './data'
import { Hairline } from './hairline'
import { createRibbonMaterial, lin, type RibbonLook } from './materials'
import { FRAME, useRuntime } from './runtime'
import { SatGlyph, useSatAnchor, type MarkTone, type SatTrackFn } from './SatMarker'
import { buildRibbon, fieldModelFor, sweptAcross } from './swath'

/** Trail length behind the satellite (≈ 2,500 km: enough to read the direction, short of the screen edge), and its sampling. */
const TRAIL_MS = 6 * 60_000
const TRAIL_STEP_S = 20
/** A sim-time jump larger than this is a seek, not playback: no flash. */
const MAX_PLAYBACK_STEP_MS = 5 * 60_000
/** The ribbon covers this much ground track either side of the place. */
export const RIBBON_CLIP_KM = 700
const FADE_IN_MS = 500
const FADE_OUT_MS = 300

/** Anchor id of a pass's satellite callout (GlobeOverlay reads the same id). */
export const passAnchorId = (passId: string) => `sel:${passId}`

export function PassOverlay() {
  const pass = useApp(selectSelectedPass)
  const place = useApp((s) => s.report?.place ?? s.place)
  const rt = useRuntime()
  useEffect(() => {
    rt.overlayNorad = pass ? pass.norad : -1
    return () => {
      rt.overlayNorad = -1
    }
  }, [rt, pass])

  // Mounted scenes: the selected pass plus any that are still fading out. Derived during render, so a newly
  // selected pass mounts in the same commit; scenes remove themselves once faded.
  const [list, setList] = useState<Pass[]>([])
  let next = list
  if (pass && pass.track.length >= 2) {
    const i = list.findIndex((p) => p.id === pass.id)
    if (i < 0) next = [...list, pass]
    else if (list[i] !== pass) next = list.map((p) => (p.id === pass.id ? pass : p))
  }
  if (next !== list) setList(next)

  return (
    <>
      {next.map((p) => (
        <PassScene key={p.id} pass={p} place={place} onGone={() => setList((l) => l.filter((x) => x.id !== p.id))} />
      ))}
    </>
  )
}

function lookFor(pass: Pass, category: SatCategory, mode: 'swath' | 'regard' | 'none'): RibbonLook & { tone: MarkTone } {
  const kind: RibbonLook['kind'] = mode === 'none' || pass.verdict === 'overhead' ? 2 : mode === 'regard' ? 1 : 0
  // Fill alphas are linear-light values on the day side; the shader halves them over unlit ground and thins
  // them over cloud. 'likely' and 'could' are quieter: no image exists.
  if (pass.verdict === 'imaged') return { tone: 'signal', color: lin(palette.signal), kind, fill: 0.07 }
  if (pass.verdict === 'likely') return { tone: 'signal', color: lin(palette.signal), kind, fill: 0.05 }
  const tone: MarkTone = category === 'radar' ? 'ice' : 'bone'
  return { tone, color: lin(tone === 'ice' ? palette.ice : palette.bone), kind, fill: kind === 1 ? 0.035 : 0.05 }
}

function PassScene({ pass, place, onGone }: { pass: Pass; place?: { lat: number; lon: number }; onGone: () => void }) {
  const rt = useRuntime()
  const info = getSatInfo(pass.norad)
  const category: SatCategory = info?.category ?? 'other'
  const field = useMemo(() => fieldModelFor(info), [info])
  const look = useMemo(() => lookFor(pass, category, field.mode), [pass, category, field.mode])
  const pointable = field.mode === 'regard' || pass.verdict === 'could'

  // ── ribbon
  const ribbon = useMemo(() => {
    const r = buildRibbon(pass.track, pass.tClosest, field.halfWidthKm, { minHalfWidthKm: 20, clipKm: RIBBON_CLIP_KM, maxStepDeg: 0.25 })
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(r.positions, 3))
    g.setAttribute('aAlong', new BufferAttribute(r.along, 1))
    g.setAttribute('aSide', new BufferAttribute(r.side, 1))
    g.setAttribute('aU', new BufferAttribute(r.u, 1))
    g.setIndex(new BufferAttribute(r.index, 1))
    g.computeBoundingSphere()
    return g
  }, [pass, field])
  const ribbonMat = useMemo(
    () =>
      createRibbonMaterial(
        { uPx: rt.uniforms.uPx, uSunDir: rt.uniforms.uSunDir, uCloudMap: rt.uniforms.uCloudMap, uCloudOffset: rt.uniforms.uCloudOffset },
        look,
        { speedKmS: pass.groundSpeedKmS > 0 ? pass.groundSpeedKmS : 6.8 },
      ),
    [rt, look, pass.groundSpeedKmS],
  )

  // ── hairlines
  const lines = useMemo(() => {
    const trailN = Math.ceil(TRAIL_MS / 1000 / TRAIL_STEP_S) + 2
    return {
      nadir: new Hairline({ capacity: 1, color: lin(palette.bone), opacity: 0.55, uPx: rt.uniforms.uPx }),
      view: new Hairline({ capacity: 1, color: look.color, opacity: 0.75, uPx: rt.uniforms.uPx }),
      trail: new Hairline({ capacity: trailN, color: look.color, opacity: 0.5, uPx: rt.uniforms.uPx }),
      trailPts: Array.from({ length: trailN + 1 }, () => new Vector3()),
      trailAlpha: new Float32Array(trailN + 1),
    }
  }, [rt, look])

  useEffect(
    () => () => {
      ribbon.dispose()
      ribbonMat.dispose()
      lines.nadir.dispose()
      lines.view.dispose()
      lines.trail.dispose()
    },
    [ribbon, ribbonMat, lines],
  )

  // Fade state. `time` is the sim time this scene draws: the clock while selected, frozen once it leaves (the
  // clock jumps back to live time on deselect; the outgoing pass must not visibly teleport while it fades).
  const fade = useRef(0)
  const anim = useRef({ active: true, from: 0, to: 1, start: performance.now(), dur: FADE_IN_MS, time: rt.simTime, gone: false })

  // Satellite state at the scene's time, shared by the glyph, callout and lines (computed once per frame).
  const sat = useRef({ at: NaN, ok: false, pos: new Vector3(), ground: new Vector3(), altKm: 0 })
  const sample = (ms: number) => {
    const s = sat.current
    if (s.at === ms) return s
    s.at = ms
    const st = propagate(pass.norad, ms)
    s.ok = !!st
    if (st) {
      latLonToWorld(st.lat, st.lon, 1 + st.altKm / EARTH_RADIUS_KM, s.pos)
      latLonToWorld(st.lat, st.lon, 1.0004, s.ground)
      s.altKm = st.altKm
    }
    return s
  }
  const track: SatTrackFn = (out) => {
    const s = sample(anim.current.time)
    out.copy(s.pos)
    return s.ok ? s.altKm : null
  }

  const placePos = useMemo(() => (place ? latLonToWorld(place.lat, place.lon, 1.0004) : null), [place])
  const nadirMesh = useRef<Mesh>(null)
  const viewMesh = useRef<Mesh>(null)
  const trailMesh = useRef<Mesh>(null)
  const trailCache = useRef({ t0: NaN, pts: [] as Vector3[] })
  const twoPts = useMemo(() => [new Vector3(), new Vector3()], [])

  useFrame((state) => {
    const perfNow = performance.now()
    const a = anim.current
    // ── selected or leaving (read every frame, so the frame of the deselect already freezes time)
    const active = useApp.getState().selectedPassId === pass.id
    if (active !== a.active) {
      a.active = active
      a.from = fade.current
      a.to = active ? 1 : 0
      a.start = perfNow
      a.dur = (active ? FADE_IN_MS : FADE_OUT_MS) * (rt.reducedMotion ? 0.4 : 1)
    }
    if (active) a.time = rt.simTime
    const u01 = Math.min(1, (perfNow - a.start) / Math.max(1, a.dur))
    fade.current = a.from + (a.to - a.from) * (active ? easeOut(u01) : easeInOut(u01))
    if (!active && u01 >= 1 && !a.gone) {
      a.gone = true
      onGone()
    }
    const f = fade.current

    const now = a.time
    const u = ribbonMat.uniforms
    u.uNow.value = (now - pass.tClosest) / 1000
    u.uOpacity.value = f
    u.uHasClouds.value = rt.uniforms.uCloudMap.value ? 1 : 0
    const db = state.gl.getDrawingBufferSize(tmpRes)
    lines.nadir.setResolution(db.x, db.y)
    lines.view.setResolution(db.x, db.y)
    lines.trail.setResolution(db.x, db.y)
    lines.nadir.setFade(f)
    lines.view.setFade(f)
    lines.trail.setFade(f)

    const s = sample(now)
    const inWindow = now >= pass.track[0].t - 60_000 && now <= pass.track[pass.track.length - 1].t + 60_000

    // Nadir line.
    if (nadirMesh.current) nadirMesh.current.visible = s.ok && f > 0.004
    if (s.ok) {
      twoPts[0].copy(s.pos)
      twoPts[1].copy(s.ground)
      lines.nadir.setPoints(twoPts)
    }

    // View line to the place, for pointable imagers while the place is in their field of regard.
    const viewOn = pointable && s.ok && !!placePos && now >= pass.tStart && now <= pass.tEnd && f > 0.004
    if (viewMesh.current) viewMesh.current.visible = viewOn
    if (viewOn && placePos) {
      twoPts[0].copy(s.pos)
      twoPts[1].copy(placePos)
      lines.view.setPoints(twoPts, VIEW_ALPHA)
    }

    // Orbit trail: SGP4 samples on a fixed time grid (cached), plus the exact head.
    if (s.ok) {
      const t0 = Math.floor((now - TRAIL_MS) / (TRAIL_STEP_S * 1000)) * TRAIL_STEP_S * 1000
      const cache = trailCache.current
      if (cache.t0 !== t0) {
        cache.t0 = t0
        cache.pts = groundTrack(pass.norad, t0 + TRAIL_STEP_S * 1000, now, TRAIL_STEP_S).map((p) =>
          latLonToWorld(p.lat, p.lon, 1 + p.altKm / EARTH_RADIUS_KM),
        )
      }
      const pts = lines.trailPts
      const alpha = lines.trailAlpha
      let n = 0
      for (const p of cache.pts) if (n < pts.length - 1) pts[n++].copy(p)
      pts[n++].copy(s.pos)
      for (let i = 0; i < n; i++) {
        const k = n > 1 ? i / (n - 1) : 1
        alpha[i] = k * k * 0.9
      }
      lines.trail.setPoints(pts, alpha, n)
    }
    if (trailMesh.current) trailMesh.current.visible = s.ok && f > 0.004

    // Flash the reticle when the front crosses the place on an imaged pass (the scan line is abeam of the place
    // at closest approach).
    if (active && pass.verdict === 'imaged' && inWindow && sweptAcross(rt.prevSimTime, rt.simTime, pass.tClosest, MAX_PLAYBACK_STEP_MS)) {
      rt.flashAt = perfNow
    }
  }, FRAME.scene)

  useSatAnchor(passAnchorId(pass.id), track)
  return (
    <>
      <mesh geometry={ribbon} material={ribbonMat} renderOrder={3} />
      <mesh ref={trailMesh} geometry={lines.trail.geometry} material={lines.trail.material} frustumCulled={false} renderOrder={4} />
      <mesh ref={nadirMesh} geometry={lines.nadir.geometry} material={lines.nadir.material} frustumCulled={false} renderOrder={4} />
      <mesh ref={viewMesh} geometry={lines.view.geometry} material={lines.view.material} frustumCulled={false} renderOrder={4} />
      <SatGlyph category={category} imaged={pass.verdict === 'imaged'} tone={look.tone} track={track} fade={fade} />
    </>
  )
}

const tmpRes = new Vector2()

/** The view line fades toward the ground so it reads as a line of sight, not a tether. */
const VIEW_ALPHA = [0.9, 0.35]
