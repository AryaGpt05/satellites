/**
 * Ground tracks across the worker boundary (K8). A week of passes is ~1,900 Pass objects with ~49 track
 * points each: as plain objects that is ~93k structured-clone objects to deserialise on the main thread
 * (measured 210 ms on a 4×-throttled phone, during the camera flight). Instead, each worker chunk sends
 * its tracks as ONE interleaved Float32Array in the transfer list (zero-copy), and `Pass.track` is
 * materialised lazily, on first read, for the few passes anyone draws (the selected one, the plan view).
 *
 * Layout: 4 floats per point [t − tClosest (s), lat (°), lon (°), altKm]; `spans` holds [start, count]
 * (in points) per pass. Float32 keeps ±480 s offsets exact at the 20 s sampling, and lat/lon to ~1 m.
 */
import type { Pass, TrackPoint } from '@/types'

export const TRACK_STRIDE = 4

export interface PackedTracks {
  points: Float32Array
  /** [start, count] per pass, in points */
  spans: Uint32Array
}

export type BarePass = Omit<Pass, 'track'>

/** Split passes into track-less objects plus one packed buffer (worker side). */
export function packTracks(passes: readonly Pass[]): { passes: BarePass[]; tracks: PackedTracks } {
  let n = 0
  for (const p of passes) n += p.track.length
  const points = new Float32Array(n * TRACK_STRIDE)
  const spans = new Uint32Array(passes.length * 2)
  const bare: BarePass[] = []
  let k = 0
  passes.forEach((p, i) => {
    spans[i * 2] = k
    spans[i * 2 + 1] = p.track.length
    for (const q of p.track) {
      const o = k * TRACK_STRIDE
      points[o] = (q.t - p.tClosest) / 1000
      points[o + 1] = q.lat
      points[o + 2] = q.lon
      points[o + 3] = q.altKm
      k++
    }
    const { track: _track, ...rest } = p
    bare.push(rest)
  })
  return { passes: bare, tracks: { points, spans } }
}

function decode(points: Float32Array, start: number, count: number, tClosest: number): TrackPoint[] {
  const out: TrackPoint[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const o = (start + i) * TRACK_STRIDE
    out[i] = { t: Math.round(tClosest + points[o] * 1000), lat: points[o + 1], lon: points[o + 2], altKm: points[o + 3] }
  }
  return out
}

/**
 * Give each bare pass a lazy `track` (main-thread side): an enumerable accessor that decodes its span on
 * first read and caches it. Assigning `track` replaces it with a plain value.
 */
export function unpackTracks(passes: BarePass[], tracks: PackedTracks): Pass[] {
  const { points, spans } = tracks
  return passes.map((bare, i) => {
    const start = spans[i * 2]
    const count = spans[i * 2 + 1]
    let cache: TrackPoint[] | undefined
    return Object.defineProperty(bare, 'track', {
      enumerable: true,
      configurable: true,
      get: () => (cache ??= decode(points, start, count, bare.tClosest)),
      set(this: Pass, v: TrackPoint[]) {
        Object.defineProperty(this, 'track', { value: v, writable: true, enumerable: true, configurable: true })
      },
    }) as Pass
  })
}

/** A shallow copy of a pass that keeps a lazy track lazy (a spread would decode it). */
export function clonePass(p: Pass): Pass {
  const d = Object.getOwnPropertyDescriptor(p, 'track')
  if (!d?.get) return { ...p }
  const out = {} as Record<string, unknown>
  for (const k in p) if (k !== 'track') out[k] = (p as unknown as Record<string, unknown>)[k]
  return Object.defineProperty(out, 'track', d) as unknown as Pass
}
