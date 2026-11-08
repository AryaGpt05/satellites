/**
 * The selected pass (store.report + store.selectedPassId), replay-synced to sim time:
 *  - swath ribbon on the surface (width = profile swath, or the field-of-regard ground range for agile imagers),
 *    built from real great-circle offsets perpendicular to the heading (swath.ts), with the pass's ground track
 *    as its centre line. It REVEALS as replay time advances, led by a bright edge across the swath;
 *  - the satellite at simTime from main-thread SGP4, placed geodetically (latLonToWorld(lat, lon, 1 + h/R)) so it
 *    sits exactly above its own track, drawn as its category glyph with a callout;
 *  - a nadir line to the ground, a fading orbit trail behind it, and for pointable imagers a view line to the
 *    place while the place is within its field of regard;
 *  - when the leading edge crosses the place on an 'imaged' pass, the reticle flashes.
 * Colour follows meaning: signal only where an image exists or is likely; agile "could have" passes are bone
 * (radar: ice) with a dashed field of regard; crewed passes draw the track alone.
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color, Mesh, ShaderMaterial, Vector2, Vector3 } from 'three'
import { EARTH_RADIUS_KM, latLonToWorld } from '@/lib/geo'
import { selectSelectedPass, useApp } from '@/state/store'
import type { Pass, SatCategory } from '@/types'
import { palette } from '@/ui/system/palette'
import { getSatInfo, groundTrack, propagate } from './data'
import { lin } from './Earth'
import { Hairline } from './hairline'
import { FRAME, useRuntime } from './runtime'
import { SatGlyph, useSatAnchor, type MarkTone, type SatTrackFn } from './SatMarker'
import { ribbonFragment, ribbonVertex } from './shaders/overlay'
import { buildRibbon, fieldModelFor, sweptAcross } from './swath'

/** Trail length behind the satellite, and its sampling. */
const TRAIL_MS = 11 * 60_000
const TRAIL_STEP_S = 20
/** A sim-time jump larger than this is a seek, not playback: no flash. */
const MAX_PLAYBACK_STEP_MS = 5 * 60_000

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
  if (!pass || pass.track.length < 2) return null
  return <PassScene key={pass.id} pass={pass} place={place} />
}

interface Look {
  tone: MarkTone
  color: Color
  /** 0 swath, 1 field of regard, 2 track only */
  kind: 0 | 1 | 2
  fill: number
}

function lookFor(pass: Pass, category: SatCategory, mode: 'swath' | 'regard' | 'none'): Look {
  const kind: Look['kind'] = mode === 'none' || pass.verdict === 'overhead' ? 2 : mode === 'regard' ? 1 : 0
  if (pass.verdict === 'imaged') return { tone: 'signal', color: lin(palette.signal), kind, fill: 0.16 }
  if (pass.verdict === 'likely') return { tone: 'signal', color: lin(palette.signal), kind, fill: 0.08 }
  const tone: MarkTone = category === 'radar' ? 'ice' : 'bone'
  return { tone, color: lin(tone === 'ice' ? palette.ice : palette.bone), kind, fill: kind === 1 ? 0.05 : 0.08 }
}

function PassScene({ pass, place }: { pass: Pass; place?: { lat: number; lon: number } }) {
  const rt = useRuntime()
  const info = getSatInfo(pass.norad)
  const category: SatCategory = info?.category ?? 'other'
  const field = useMemo(() => fieldModelFor(info), [info])
  const look = useMemo(() => lookFor(pass, category, field.mode), [pass, category, field.mode])
  const pointable = field.mode === 'regard' || pass.verdict === 'could'

  // ── ribbon
  const ribbon = useMemo(() => {
    const r = buildRibbon(pass.track, pass.tClosest, field.halfWidthKm, { minHalfWidthKm: 20 })
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
      new ShaderMaterial({
        vertexShader: ribbonVertex,
        fragmentShader: ribbonFragment,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        uniforms: {
          uNow: { value: -1e9 },
          uPx: rt.uniforms.uPx,
          uKind: { value: look.kind },
          uColor: { value: look.color },
          uFill: { value: look.fill },
          uOpacity: { value: 0 },
        },
      }),
    [rt, look],
  )

  // ── hairlines
  const lines = useMemo(() => {
    const trailN = Math.ceil(TRAIL_MS / 1000 / TRAIL_STEP_S) + 2
    return {
      nadir: new Hairline({ capacity: 1, color: lin(palette.bone), opacity: 0.55, uPx: rt.uniforms.uPx }),
      view: new Hairline({ capacity: 1, color: look.color, opacity: 0.75, uPx: rt.uniforms.uPx }),
      trail: new Hairline({ capacity: trailN, color: look.color, opacity: 0.6, uPx: rt.uniforms.uPx }),
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

  // Satellite state at simTime, shared by the glyph, callout and lines (computed once per frame).
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
    const s = sample(rt.simTime)
    out.copy(s.pos)
    return s.ok ? s.altKm : null
  }

  const placePos = useMemo(() => (place ? latLonToWorld(place.lat, place.lon, 1.0004) : null), [place])
  const nadirMesh = useRef<Mesh>(null)
  const viewMesh = useRef<Mesh>(null)
  const trailMesh = useRef<Mesh>(null)
  const trailCache = useRef({ t0: NaN, pts: [] as Vector3[] })
  const twoPts = useMemo(() => [new Vector3(), new Vector3()], [])

  useFrame((state, dt) => {
    const now = rt.simTime
    const u = ribbonMat.uniforms
    u.uNow.value = (now - pass.tClosest) / 1000
    u.uOpacity.value = Math.min(1, u.uOpacity.value + dt / (rt.reducedMotion ? 0.15 : 0.5))
    const db = state.gl.getDrawingBufferSize(tmpRes)
    for (const l of [lines.nadir, lines.view, lines.trail]) l.setResolution(db.x, db.y)

    const s = sample(now)
    const inWindow = now >= pass.track[0].t - 60_000 && now <= pass.track[pass.track.length - 1].t + 60_000

    // Nadir line.
    if (nadirMesh.current) nadirMesh.current.visible = s.ok
    if (s.ok) {
      twoPts[0].copy(s.pos)
      twoPts[1].copy(s.ground)
      lines.nadir.setPoints(twoPts)
    }

    // View line to the place, for pointable imagers while the place is in their field of regard.
    const viewOn = pointable && s.ok && !!placePos && now >= pass.tStart && now <= pass.tEnd
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
        const f = n > 1 ? i / (n - 1) : 1
        alpha[i] = f * f * 0.9
      }
      lines.trail.setPoints(pts, alpha, n)
    }
    if (trailMesh.current) trailMesh.current.visible = s.ok

    // Flash the reticle when the leading edge crosses the place on an imaged pass (the scan line is abeam
    // of the place at closest approach).
    if (pass.verdict === 'imaged' && inWindow && sweptAcross(rt.prevSimTime, now, pass.tClosest, MAX_PLAYBACK_STEP_MS)) {
      rt.flashAt = performance.now()
    }
  }, FRAME.scene)

  useSatAnchor('selected', track)
  return (
    <>
      <mesh geometry={ribbon} material={ribbonMat} renderOrder={3} />
      <mesh ref={trailMesh} geometry={lines.trail.geometry} material={lines.trail.material} frustumCulled={false} renderOrder={4} />
      <mesh ref={nadirMesh} geometry={lines.nadir.geometry} material={lines.nadir.material} frustumCulled={false} renderOrder={4} />
      <mesh ref={viewMesh} geometry={lines.view.geometry} material={lines.view.material} frustumCulled={false} renderOrder={4} />
      <SatGlyph category={category} filled={pass.verdict === 'imaged'} tone={look.tone} track={track} />
    </>
  )
}

const tmpRes = new Vector2()

/** The view line fades toward the ground so it reads as a line of sight, not a tether. */
const VIEW_ALPHA = [0.9, 0.35]
