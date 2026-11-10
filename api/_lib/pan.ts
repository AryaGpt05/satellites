/**
 * Landsat 8/9's 15 m panchromatic band for one of the app's crops (GET /api/pan, api/pan.ts), from the Copernicus
 * Data Space Ecosystem's Sentinel Hub Process API (collection `landsat-ot-l1`, band B08). Planetary Computer's
 * Landsat Collection 2 Level-2 (what every photo is made from) has no pan band; Level-1 has, on the same scene
 * grid, so the pan pixels register exactly over the 30 m colour of the same capture.
 *
 * Only crops the app itself cuts are served (validated here), so the endpoint cannot be used as a general proxy for
 * the free CDSE quota: a 15 km square on the scene's UTM grid (whole 15 m pixels), 1000 px (its 15 m pixels 1:1),
 * within an hour of a capture from the last 120 days. The answer is an 8-bit grey PNG, square-root encoded
 * (v = 255·√(R / 0.64), R the top-of-atmosphere reflectance), so dark water keeps enough levels for the pan-sharpening
 * ratio; 0 is no data. Pure functions here; the handler (token, fetch, cache headers) is api/pan.ts.
 */

export const PAN_PX = 1000
export const PAN_SIDE_M = 15_000
export const PAN_GSD_M = 15
/** Reflectance at code 255 (√ encoding): bright desert and roofs stay below it; cloud and snow clip, harmlessly. */
export const PAN_TOP_REFL = 0.64
const WINDOW_MS = 60 * 60_000
const MAX_AGE_MS = 120 * 24 * 3_600_000

export interface PanRequest {
  box: [number, number, number, number]
  crs: number
  t: number
}

/** The query of /api/pan for a crop (the client builds it with this too: src/ui/results/lib/photos.ts). */
export function panQuery(box: readonly number[], crs: number, t: number): string {
  return `bbox=${box.map((v) => Math.round(v)).join(',')}&crs=${crs}&t=${Math.round(t)}`
}

const isUtm = (crs: number) => (crs >= 32601 && crs <= 32660) || (crs >= 32701 && crs <= 32760)

/** The request, or why it is refused (an app crop only; see the header). */
export function parsePanQuery(q: URLSearchParams, now: number): PanRequest | string {
  const box = (q.get('bbox') ?? '').split(',').map(Number)
  if (box.length !== 4 || !box.every(Number.isInteger)) return 'bbox'
  if (box[2] - box[0] !== PAN_SIDE_M || box[3] - box[1] !== PAN_SIDE_M) return 'bbox size'
  if (box.some((v) => v % PAN_GSD_M !== 0)) return 'bbox grid'
  const crs = Number(q.get('crs'))
  if (!Number.isInteger(crs) || !isUtm(crs)) return 'crs'
  const t = Number(q.get('t'))
  if (!Number.isFinite(t) || t > now + WINDOW_MS || t < now - MAX_AGE_MS) return 't'
  return { box: box as PanRequest['box'], crs, t }
}

const EVALSCRIPT = `//VERSION=3
function setup() {
  return { input: [{ bands: ["B08", "dataMask"], units: ["REFLECTANCE", "DN"] }], output: { bands: 1, sampleType: "UINT8" } }
}
function evaluatePixel(s) {
  if (!s.dataMask) return [0]
  return [Math.max(1, Math.min(255, Math.round(255 * Math.sqrt(Math.max(0, s.B08) / ${PAN_TOP_REFL}))))]
}`

/** The Process API request for `r`: B08 only, the capture's own hour (no other scene mixed in), nearest-neighbour on the grid. */
export function processBody(r: PanRequest) {
  const iso = (ms: number) => new Date(ms).toISOString()
  return {
    input: {
      bounds: { bbox: r.box, properties: { crs: `http://www.opengis.net/def/crs/EPSG/0/${r.crs}` } },
      data: [
        {
          type: 'landsat-ot-l1',
          dataFilter: { timeRange: { from: iso(r.t - WINDOW_MS), to: iso(r.t + WINDOW_MS) }, mosaickingOrder: 'mostRecent' },
          processing: { upsampling: 'NEAREST', downsampling: 'NEAREST' },
        },
      ],
    },
    output: { width: PAN_PX, height: PAN_PX, responses: [{ identifier: 'default', format: { type: 'image/png' } }] },
    evalscript: EVALSCRIPT,
  }
}
