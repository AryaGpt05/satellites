/**
 * The panel photo's outline on the painted decal (Imagery.tsx feeds it, shaders/earth.ts draws it): the decal's patch
 * on the sphere, the photo's half extent in that patch and its turn on the map. The decal is lon/lat, north up; a
 * Sentinel-2 / Landsat photo is cut on the place's UTM grid, grid north up, so its square is turned on the map by the
 * meridian convergence (api/_lib/toneRender.ts northInCropDeg). Pure: panel.test.ts checks the shader's arithmetic.
 */
import { Vector4 } from 'three'
import { bboxAround } from '@/lib/geo'
import type { Capture, CaptureCollection } from '@/types'

/**
 * Half extent of the panel's photo (results lib/captures cropSpec: Sentinel-2 ±5 km, Landsat ±7.5 km, daily mosaics
 * ±120 km), marked on the painted image as a hairline square.
 */
export function panelHalfKm(c: CaptureCollection): number {
  if (c === 'sentinel-2-l2a') return 5
  if (c === 'landsat-c2-l2') return 7.5
  return 120
}

/**
 * The panel's photo of a capture, as the panel asks for it (results lib/photos cardUrl, but for the format): which way
 * it is turned on the map is read from it. Its box depends on the place and the half extent only, not on `px`.
 */
export const panelPhotoUrl = (cap: Pick<Capture, 'collection' | 'cropUrl'>) => cap.cropUrl({ halfSizeKm: panelHalfKm(cap.collection), px: 1000 })

/** Patch bounds in sphere uv: (u centre, v centre, u width, v height). */
export function patchUv(lat: number, lon: number, halfKm: number, out: Vector4): Vector4 {
  const [w, s, e, n] = bboxAround(lat, lon, halfKm)
  return out.set(0.5 + lon / 360, 0.5 + lat / 180, (e - w) / 360, (n - s) / 180)
}

/**
 * The shader's uPanelTurn for a photo whose true north points `northDeg` clockwise from its up: (cos, sin) of the
 * photo's turn on the map, counter-clockwise from north up (the same angle: turning the photo so its N arrow points up
 * turns its up edge that far the other way).
 */
export const panelTurn = (northDeg: number): [number, number] => [Math.cos((northDeg * Math.PI) / 180), Math.sin((northDeg * Math.PI) / 180)]

/**
 * A point of the decal patch, centred (east, north in patch units), in the panel photo's own axes (right, up): the
 * shader's arithmetic (earth.ts: dot(pm, (c, s)), dot(pm, (−s, c))). The photo's square is |x|, |y| ≤ its half extent.
 */
export const inPanelAxes = (pm: readonly [number, number], turn: readonly [number, number]): [number, number] => [
  pm[0] * turn[0] + pm[1] * turn[1],
  -pm[0] * turn[1] + pm[1] * turn[0],
]
