/**
 * How a Sentinel-2 / Landsat photo is rendered and toned, shared by every renderer so they show the same
 * pixels (owner rule d): the app's photos (src/imagery: the pixels worker), the in-app share card (it cuts
 * the app's decoded photo), the downloaded PNG (canvas, from the same decoded photo) and the server's Open
 * Graph card (api/_lib/imagery.ts). The URL half (the render, the mask request, the measuring region) lives in
 * ./toneRender.ts and is re-exported here; this file adds the pixel work. No other imports: the browser bundle and
 * the functions share both.
 *
 * 1. The render Planetary Computer makes (`pcRenderQuery`): the surface-reflectance bands (S2 B04/B03/B02,
 *    Landsat red/green/blue), cut on the place's UTM grid at whole native pixels (a scene on that grid: no warp,
 *    the archive's own pixels; toneRender.ts placeGrid / nativeBox), any other scene, the globe's decals and places
 *    beyond UTM warped with Lanczos (`reproject=lanczos`: the default nearest warp leaves 10 m / 30 m stair-steps),
 *    and sent as the SQUARE ROOT of
 *    reflectance over [0, ENC_TOP_REFL]. The root spreads PC's 8 bits over the shadows, where low-sun scenes
 *    live, so our own curve never stretches a handful of dark levels into bands. Baseline-aware: Sentinel-2
 *    products from processing baseline 04.00 on carry a +1000 offset that PC does not remove.
 * 2. One tone curve per photo (`measureTone`), the same for every pixel: a black point (the darkest 0.5 % of any
 *    channel of the ground, never above BLACK_MAX), a white point (the 99.5th percentile of the luminance each ground
 *    pixel needs for its brightest channel to fit once coloured; cloud, thin cirrus and cloud shadow left out where
 *    the archive's own classification marks them), and a gamma that puts the ground's median luminance near 42 % grey
 *    (48 % for bright desert / snow scenes), clamped to [0.55, 0.8]. A frame of cloud is exposed for the cloud (white
 *    point ≤ CLOUD_WHITE_MAX), so an overcast deck reads white with texture. The curve acts on luminance; colour keeps
 *    its ratios (raised to a fixed 0.55, so hues do not shift with the scene's gamma); then saturation ×1.2 around
 *    luma; colour that would leave the screen gives up colour, not hue or brightness (blown cloud goes white, not
 *    cream); the JPEG's 8-px compression grid is smoothed in flat areas; a light unsharp mask on luma (`applyTone`).
 *    Global only: no local contrast, no inpainting, nothing added or removed.
 *    Measured on 25 real scenes (2026-11, see the change notes): a gamma ceiling of 1.2 turned bright deserts orange
 *    and dark, and snow scenes crushed their valleys, so the ceiling is 0.8; a white point on luminance alone clipped
 *    the red of red deserts over half the frame; an uncapped black point turned cloud decks purple and murky.
 * 3. The curve is measured over ONE region every renderer can derive: the share card's square around the
 *    place rounded to 0.01° (the server only knows the rounded point). The cloud mask comes from one small
 *    request every renderer builds the same way (`maskUrl`, a 64 px npy of SCL / QA_PIXEL around the rounded
 *    point, in lon/lat whatever the crop's geometry: toMaskCrs), which also answers the spot check and the clear
 *    fraction for the ranking (src/imagery/cloud.ts).
 */

import { ENC_TOP_REFL, NATIVE_GSD_M, isToneCollection, type Box, type ToneCollection, type TonePlan } from './toneRender.js'
import { utmInverse } from './utm.js'

export * from './toneRender.js'

// ── The mask (cloud classes around the rounded point) ───────────────────────────────────────

export interface Npy {
  shape: number[]
  data: Uint8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array
}

/** Parse a .npy file (little-endian numeric arrays, C order): enough for titiler's npy output. */
export function parseNpy(input: ArrayBuffer | Uint8Array): Npy {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (u8.length < 10 || u8[0] !== 0x93 || String.fromCharCode(...u8.subarray(1, 6)) !== 'NUMPY') throw new Error('not an npy file')
  const major = u8[6]
  const hlen = major >= 2 ? u8[8] | (u8[9] << 8) | (u8[10] << 16) | (u8[11] << 24) : u8[8] | (u8[9] << 8)
  const hstart = major >= 2 ? 12 : 10
  let header = ''
  for (let i = hstart; i < hstart + hlen; i++) header += String.fromCharCode(u8[i])
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1]
  const shapeStr = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1]
  if (!descr || shapeStr === undefined || /'fortran_order':\s*True/.test(header)) throw new Error('unsupported npy header')
  const shape = shapeStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
  const n = shape.reduce((a, b) => a * b, 1)
  const off = hstart + hlen
  // A copy, aligned for the typed array below. Uint8Array.prototype.slice, never Buffer#slice (a view that shares the
  // whole buffer: the header would be read as data).
  const bytes = Uint8Array.prototype.slice.call(u8, off) as Uint8Array
  const kinds: Record<string, new (b: ArrayBuffer, o: number, n: number) => Npy['data']> = {
    '|u1': Uint8Array,
    '<u1': Uint8Array,
    '<u2': Uint16Array,
    '<i2': Int16Array,
    '<u4': Uint32Array,
    '<i4': Int32Array,
    '<f4': Float32Array,
    '<f8': Float64Array,
  }
  const K = kinds[descr]
  if (!K) throw new Error(`unsupported npy dtype ${descr}`)
  const need = n * (K as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
  if (bytes.byteLength < need) throw new Error('truncated npy')
  return {
    shape,
    data: new K(bytes.buffer as ArrayBuffer, bytes.byteOffset, n),
  }
}

/** Per-cell class of the mask grid. */
export const Cell = {
  NoData: 0,
  Clear: 1,
  Cloud: 2,
  Cirrus: 3,
  Shadow: 4,
} as const
export type Cell = (typeof Cell)[keyof typeof Cell]

export interface ToneMask {
  collection: ToneCollection
  /** The mask's square, lon/lat degrees (always: toneRender maskUrl; crops on a UTM grid read it through toMaskCrs) */
  box: Box
  w: number
  h: number
  /** Raw class values (SCL value / QA_PIXEL bits), row 0 = north */
  raw: Uint16Array
  /** Cell class (Cell) */
  cls: Uint8Array
}

/** Sentinel-2 SCL value → cell class: 8, 9 cloud; 10 thin cirrus; 3 cloud shadow; 0, 1 no data / defective. */
export function sclCell(v: number): Cell {
  if (v === 8 || v === 9) return Cell.Cloud
  if (v === 10) return Cell.Cirrus
  if (v === 3) return Cell.Shadow
  if (v === 0 || v === 1) return Cell.NoData
  return Cell.Clear
}

/**
 * Landsat C2 QA_PIXEL bits → cell class: 0 fill; 1 dilated cloud, 2 cirrus, 3 cloud → cloud; 4 cloud shadow. The same
 * mapping as the spot check (src/imagery/cloud.ts classifyQaPixel): Landsat's cirrus bit comes from its own cirrus
 * band and is not SCL's thin-cirrus class, which also fires on bright roofs.
 */
export function qaCell(v: number): Cell {
  if (v & 1) return Cell.NoData
  if (v & ((1 << 1) | (1 << 2) | (1 << 3))) return Cell.Cloud
  if (v & (1 << 4)) return Cell.Shadow
  return Cell.Clear
}

/** The mask grid from titiler's npy (bands × h × w: the class band, then the validity mask 0 / 255). */
export function maskFromNpy(collection: ToneCollection, box: Box, npy: Npy): ToneMask {
  const [bands, h, w] = npy.shape.length === 3 ? npy.shape : [1, npy.shape[0], npy.shape[1]]
  if (!(h > 0 && w > 0) || npy.data.length < bands * h * w) throw new Error('bad mask shape')
  const n = w * h
  const raw = new Uint16Array(n)
  const cls = new Uint8Array(n)
  const toCell = collection === 'sentinel-2-l2a' ? sclCell : qaCell
  const hasValid = bands >= 2
  for (let i = 0; i < n; i++) {
    const v = Number(npy.data[i])
    raw[i] = v
    const valid = !hasValid || Number(npy.data[(bands - 1) * n + i]) > 0
    cls[i] = valid ? toCell(v) : Cell.NoData
  }
  return { collection, box, w, h, raw, cls }
}

const MASK_URL_RE = /\/item\/bbox\/(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\/\d+x\d+\.npy\?(.*)$/

/** The mask grid from a `maskUrl` and its npy body (the URL says the collection and the square, in lon/lat). */
export function maskFromResponse(url: string, body: ArrayBuffer | Uint8Array): ToneMask {
  const m = MASK_URL_RE.exec(url)
  const q = m ? new URLSearchParams(m[5]) : null
  const collection = q?.get('collection') ?? ''
  // maskUrl never asks for a grid (coord_crs / dst_crs): a box in metres is not one of ours.
  if (!m || !q || !isToneCollection(collection) || q.has('coord_crs') || q.has('dst_crs')) throw new Error('not a mask URL')
  return maskFromNpy(collection, [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])], parseNpy(body))
}

/** Mask cell under a lon/lat (`x` = lon, `y` = lat, on the mask's side of the antimeridian), or −1 off the grid. */
export function maskCellAt(m: ToneMask, x: number, y: number): number {
  const i = Math.floor(((x - m.box[0]) / (m.box[2] - m.box[0])) * m.w)
  const j = Math.floor(((m.box[3] - y) / (m.box[3] - m.box[1])) * m.h)
  return i >= 0 && j >= 0 && i < m.w && j < m.h ? j * m.w + i : -1
}

/**
 * A lat/lon as the mask's [lon, lat], the longitude taken on the mask's side of the antimeridian (a box near ±180°
 * runs past it).
 */
export function maskPoint(m: Pick<ToneMask, 'box'>, lat: number, lon: number): [number, number] {
  const c = (m.box[0] + m.box[2]) / 2
  return [lon + 360 * Math.round((c - lon) / 360), lat]
}

/** Mask cell under a lat/lon (either side of the antimeridian), or −1 off the grid. */
export function maskCellAtLatLon(m: ToneMask, lat: number, lon: number): number {
  const [x, y] = maskPoint(m, lat, lon)
  return maskCellAt(m, x, y)
}

/** Lattice cells per side over which toMaskCrs interpolates (81 exact projections a crop). */
const MAP_CELLS = 8

/**
 * A point of a crop in `crs` → the same ground point in the (lon/lat) mask, or null for a lon/lat crop (the mask's
 * own geometry). A crop on a UTM grid reads the mask through lat/lon: projected exactly on an 8 × 8 lattice over the
 * crop and bilinearly within its cells (≤ 0.2 m off over a 15 km crop, against 156 m mask cells; a projection per
 * sample would cost ~0.3 s a photo).
 */
export function toMaskCrs(m: ToneMask, crs: number, box: Box): ((x: number, y: number) => [number, number]) | null {
  if (crs === 4326) return null
  const exact = (x: number, y: number): [number, number] => {
    const [lat, lon] = utmInverse(crs, x, y)
    return maskPoint(m, lat, lon)
  }
  const N = MAP_CELLS
  const [w, s, e, n] = box
  const cw = (e - w) / N
  const ch = (n - s) / N
  const lx = new Float64Array((N + 1) * (N + 1))
  const ly = new Float64Array((N + 1) * (N + 1))
  for (let j = 0; j <= N; j++)
    for (let i = 0; i <= N; i++) {
      const [px, py] = exact(w + i * cw, s + j * ch)
      lx[j * (N + 1) + i] = px
      ly[j * (N + 1) + i] = py
    }
  return (x, y) => {
    const fx = (x - w) / cw
    const fy = (y - s) / ch
    const i = Math.min(N - 1, Math.max(0, Math.floor(fx)))
    const j = Math.min(N - 1, Math.max(0, Math.floor(fy)))
    const u = fx - i
    const v = fy - j
    const k = j * (N + 1) + i
    const a = (1 - u) * (1 - v)
    const b = u * (1 - v)
    const c = (1 - u) * v
    const d = u * v
    return [a * lx[k] + b * lx[k + 1] + c * lx[k + N + 1] + d * lx[k + N + 2], a * ly[k] + b * ly[k + 1] + c * ly[k + N + 1] + d * ly[k + N + 2]]
  }
}

/**
 * Share of the photo's square that shows the ground: clear 1, thin cirrus ½ (SCL 10 also fires on bright roofs),
 * cloud and cloud shadow 0; no-data cells left out. Undefined when under half the square has data.
 */
export function clearFraction(m: ToneMask): number | undefined {
  let valid = 0
  let clear = 0
  for (let i = 0; i < m.cls.length; i++) {
    const c = m.cls[i]
    if (c === Cell.NoData) continue
    valid++
    if (c === Cell.Clear) clear += 1
    else if (c === Cell.Cirrus) clear += 0.5
  }
  return valid >= m.cls.length / 2 ? clear / valid : undefined
}

// ── The curve ───────────────────────────────────────────────────────────────────────────────

export interface ToneParams {
  /** Black and white points, as fractions of ENC_TOP_REFL (linear reflectance) */
  black: number
  white: number
  gamma: number
  saturation: number
}

/** Encoded byte → linear reflectance fraction (the render is the square root). */
export const decodeLinear = (v: number) => (v / 255) * (v / 255)

const SATURATION = 1.2
const GAMMA_MIN = 0.55
const GAMMA_MAX = 0.8
/** Median luminance lands near this grey; bright scenes (median reflectance ≥ 0.18) a little higher. */
const TARGET_DARK = 0.42
const TARGET_BRIGHT = 0.48
/**
 * The black point never sits above this reflectance: real ground always has something this dark (water, shade,
 * forest). Only a frame of cloud measures higher, and lifting its black there turned overcast decks purple and murky.
 */
export const BLACK_MAX = 0.06
/** A frame that is (nearly) all cloud: white point at most this, so the deck reads white with texture. */
export const CLOUD_WHITE_MAX = 0.85
/** The white point's percentile (of the ground's luminance need): the brightest 0.5 % may clip, softly (see applyTone). */
const WHITE_PCT = 99.5
const BINS = 4096
/** The colour factor table of the white point's search: factors 1…1 + K_MAX in steps of 1 / K_STEPS. */
const K_STEPS = 512
const K_MAX = 6
/** Effective-luminance histogram range (reflectance): colourful highlights can need a white point above 1. */
const E_RANGE = 2
/** At most this many pixels are read to measure a curve (a regular sample beyond it). */
const SAMPLE_MAX = 250_000

/** Neutral curve for a picture with nothing to measure. */
export const NEUTRAL_TONE: ToneParams = {
  black: 0,
  white: 0.35,
  gamma: 0.8,
  saturation: SATURATION,
}

/** Chroma exponent: colour ratios are rendered as (channel / luminance)^CHROMA whatever the brightness curve. */
export const CHROMA = 0.55
/**
 * Share of the black point taken out of the colour ratios. All of it (the reviewed first cut) inflated the colour of
 * dark ground (teal forest, cerulean sea: the ratios of what little is left above black); none left deserts and
 * cities dull and hazy. Half is measured on 25 scenes to stay close to the archive's own colour.
 */
export const CHROMA_BLACK = 0.5
const RATIO_STEPS = 512
const RATIO_MAX = 8
let ratioLut: Float32Array | null = null
function ratioTable(): Float32Array {
  if (!ratioLut) {
    ratioLut = new Float32Array(RATIO_STEPS * RATIO_MAX + 1)
    for (let i = 0; i < ratioLut.length; i++) ratioLut[i] = Math.pow(i / RATIO_STEPS, CHROMA)
  }
  return ratioLut
}
let linLut: Float32Array | null = null
function linTable(): Float32Array {
  if (!linLut) {
    linLut = new Float32Array(256)
    for (let v = 0; v < 256; v++) linLut[v] = decodeLinear(v)
  }
  return linLut
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function percentile(hist: Uint32Array, total: number, p: number, range = 1): number {
  if (total <= 0) return 0
  const target = (p / 100) * total
  let acc = 0
  for (let i = 0; i < hist.length; i++) {
    const next = acc + hist[i]
    if (next >= target && hist[i] > 0) return ((i + (target - acc) / hist[i]) / hist.length) * range
    acc = next
  }
  return range
}

/**
 * How far a pixel's brightest channel sits above its luminance once coloured (display channel = curve(L) × factor):
 * the reflectance ratios c / L raised to CHROMA, renormalised so luma stays curve(L), then saturation s around 1.
 * Returns the largest factor (≥ 1 for any colour).
 */
function maxFactor(r: number, g: number, b: number, L: number, s: number, lut: Float32Array): number {
  const k = RATIO_STEPS / L
  const fr = r * k >= RATIO_STEPS * RATIO_MAX ? Math.pow(r / L, CHROMA) : lut[Math.round(r * k)]
  const fg = g * k >= RATIO_STEPS * RATIO_MAX ? Math.pow(g / L, CHROMA) : lut[Math.round(g * k)]
  const fb = b * k >= RATIO_STEPS * RATIO_MAX ? Math.pow(b / L, CHROMA) : lut[Math.round(b * k)]
  const l = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb
  return l > 1e-6 ? 1 + s * (Math.max(fr, fg, fb) / l - 1) : 1
}

function gammaFor(black: number, white: number, median: number): number {
  const m = Math.min(0.95, Math.max(0.02, (median - black) / (white - black)))
  const target = TARGET_DARK + (TARGET_BRIGHT - TARGET_DARK) * smoothstep(0.1, 0.18, median * ENC_TOP_REFL)
  return Math.min(GAMMA_MAX, Math.max(GAMMA_MIN, Math.log(target) / Math.log(m)))
}

/**
 * A crop much coarser than the archive (a 112 px thumbnail is ~89 m per pixel for Sentinel-2) reads a lower white
 * point than the photo it stands for: each of its pixels averages dozens of native ones, so the brightest roofs and
 * fields are diluted. Its span (white − black) is widened by up to this factor (the median card / thumbnail ratio over
 * 25 scenes was 1.2, mean 1.25; 1.0 for cloud decks and snow, which the cap below leaves alone). Only used when the
 * capture's own curve is not known yet; once it is, every size uses it.
 */
export const COARSE_SPAN_GAIN = 1.25
/** …never past this white point (bright snow and cloud read the same at any scale). */
const COARSE_WHITE_MAX = 0.6

/** The span gain for a crop of `metresPerPx`: 1 at up to 1.6 × native, COARSE_SPAN_GAIN at 8 × native and coarser. */
export function coarseSpanGain(collection: ToneCollection, metresPerPx: number): number {
  const f = Math.log(metresPerPx / (1.6 * NATIVE_GSD_M[collection])) / Math.log(5)
  return 1 + (COARSE_SPAN_GAIN - 1) * Math.min(1, Math.max(0, f))
}

/** Optional diagnostics of a measurement (tests, tuning). */
export interface ToneStats {
  median: number
  whiteL: number
  whiteE: number
  whiteCap: number
  cloudy: boolean
  groundShare: number
  use: number
}

/**
 * Measure the curve of an encoded crop (RGBA, row 0 = north) over `ref`, from the ground (cloud, thin cirrus and
 * cloud-shadow cells of `mask` left out, grown by one cell):
 *  - black point: the lowest channel's 0.5th percentile, at most BLACK_MAX;
 *  - white point: the 99.5th percentile of the luminance each pixel needs so that its brightest channel, once
 *    coloured, still fits (so bright colourful ground such as red sand keeps its detail instead of clipping one
 *    channel);
 *  - gamma: ln(target) / ln(normalised median), clamped to [GAMMA_MIN, GAMMA_MAX].
 * A frame of cloud (real cloud, not SCL's thin-cirrus class, which also fires on bright roofs, over nearly all of it)
 * is exposed for the cloud: every pixel counts, the white point at most CLOUD_WHITE_MAX (the gamma rule then lands a deck
 * near GAMMA_MAX on its own, and keeps the ground in the gaps of a broken deck visible).
 */
export function measureTone(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  box: Box,
  ref: Box,
  mask?: ToneMask | null,
  stats?: Partial<ToneStats>,
  spanGain = 1,
  crs = 4326,
): ToneParams {
  const sx = width / (box[2] - box[0])
  const sy = height / (box[3] - box[1])
  let x0 = Math.max(0, Math.floor((ref[0] - box[0]) * sx))
  let x1 = Math.min(width, Math.ceil((ref[2] - box[0]) * sx))
  let y0 = Math.max(0, Math.floor((box[3] - ref[3]) * sy))
  let y1 = Math.min(height, Math.ceil((box[3] - ref[1]) * sy))
  if (x1 - x0 < 4 || y1 - y0 < 4) {
    x0 = 0
    y0 = 0
    x1 = width
    y1 = height
  }
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / SAMPLE_MAX)))
  const lin = linTable()
  const lut = ratioTable()
  // Histograms (channels for the black point, luminance for the median) over three sets: every pixel, the ground
  // without cloud or cirrus or shadow, and the ground without cloud or shadow (when SCL's cirrus covers the ground).
  const sets = [0, 1, 2].map(() => ({
    r: new Uint32Array(BINS),
    g: new Uint32Array(BINS),
    b: new Uint32Array(BINS),
    L: new Uint32Array(BINS),
    n: 0,
  }))
  // Per sample: luminance, its colour's max factor, and the sets it is in (the white point needs the gamma first).
  const cap = Math.ceil((x1 - x0) / step) * Math.ceil((y1 - y0) / step)
  const sR = new Float32Array(cap)
  const sGr = new Float32Array(cap)
  const sB = new Float32Array(cap)
  const sSet = new Uint8Array(cap)
  let ns = 0
  const bin = (v: number) => Math.min(BINS - 1, Math.max(0, Math.floor(v * BINS)))
  const dLon = (box[2] - box[0]) / width
  const dLat = (box[3] - box[1]) / height
  const near = mask ? cloudNear(mask) : null
  const toMask = mask ? toMaskCrs(mask, crs, box) : null
  for (let y = y0; y < y1; y += step) {
    const lat = box[3] - (y + 0.5) * dLat
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4
      const r8 = rgba[i]
      const g8 = rgba[i + 1]
      const b8 = rgba[i + 2]
      if (rgba[i + 3] < 128 || r8 + g8 + b8 === 0) continue // no data
      const rl = lin[r8]
      const gl = lin[g8]
      const bl = lin[b8]
      const Lv = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl
      // Bit 0: every pixel; bit 1: clear ground; bit 2: ground but for cirrus.
      let in3 = 0b111
      if (mask && near) {
        const px = box[0] + (x + 0.5) * dLon
        const c = toMask ? maskCellAt(mask, ...toMask(px, lat)) : maskCellAt(mask, px, lat)
        if (c >= 0) {
          if (near[c] & NEAR_CLOUD || mask.cls[c] === Cell.Shadow) in3 = 0b001
          else if (near[c] & NEAR_CIRRUS) in3 = 0b101
        }
      }
      const r = bin(rl)
      const g = bin(gl)
      const b = bin(bl)
      const L = bin(Lv)
      for (let k = 0; k < 3; k++) {
        if (!(in3 & (1 << k))) continue
        const h = sets[k]
        h.r[r]++
        h.g[g]++
        h.b[b]++
        h.L[L]++
        h.n++
      }
      sR[ns] = rl
      sGr[ns] = gl
      sB[ns] = bl
      sSet[ns++] = in3
    }
  }
  const all = sets[0]
  if (all.n < 64) return NEUTRAL_TONE
  const enough = (n: number) => n >= Math.max(256, all.n * 0.03)
  // The ground; else the ground SCL calls thin cirrus too (it fires on bright roofs); else a frame of cloud.
  const use = enough(sets[1].n) ? 1 : enough(sets[2].n) ? 2 : 0
  const cloudFrame = use === 0
  const h = sets[use]
  const black = Math.min(BLACK_MAX, Math.max(0, Math.min(percentile(h.r, h.n, 0.5), percentile(h.g, h.n, 0.5), percentile(h.b, h.n, 0.5))))
  const median = percentile(h.L, h.n, 50)
  const whiteL = percentile(h.L, h.n, WHITE_PCT)
  const whiteCap = cloudFrame ? CLOUD_WHITE_MAX : E_RANGE
  // The white point from each pixel's need (its luminance scaled so its brightest channel fits), a few rounds: the
  // need depends on the gamma, the gamma on the white point (it settles in two or three).
  let white = Math.max(black + 0.02, Math.min(whiteL, whiteCap))
  let gamma = gammaFor(black, white, median)
  let whiteE = whiteL
  const eh = new Uint32Array(BINS)
  const bit = 1 << use
  const cb = CHROMA_BLACK * black
  // Per sample: luminance over the black point, and its colour's max factor as an index into a per-round power table.
  const sD = new Float32Array(ns)
  const sKi = new Uint16Array(ns)
  for (let j = 0; j < ns; j++) {
    const L = 0.2126 * sR[j] + 0.7152 * sGr[j] + 0.0722 * sB[j]
    sD[j] = L - black
    const k = L - cb > 1e-6 ? maxFactor(Math.max(0, sR[j] - cb), Math.max(0, sGr[j] - cb), Math.max(0, sB[j] - cb), L - cb, SATURATION, lut) : 1
    sKi[j] = Math.min(K_STEPS * K_MAX, Math.max(0, Math.round((k - 1) * K_STEPS)))
  }
  const kpow = new Float32Array(K_STEPS * K_MAX + 1)
  for (let round = 0; round < 4; round++) {
    eh.fill(0)
    let n = 0
    const inv = 1 / gamma
    for (let i = 0; i < kpow.length; i++) kpow[i] = Math.pow(1 + i / K_STEPS, inv)
    for (let j = 0; j < ns; j++) {
      if (!(sSet[j] & bit)) continue
      const d = sD[j]
      const e = black + (d > 0 ? d * kpow[sKi[j]] : d)
      const b = Math.floor((e / E_RANGE) * BINS)
      eh[b < 0 ? 0 : b >= BINS ? BINS - 1 : b]++
      n++
    }
    whiteE = Math.max(whiteL, percentile(eh, n, WHITE_PCT, E_RANGE))
    const before = white
    white = Math.max(black + 0.02, Math.min(whiteE, whiteCap))
    gamma = gammaFor(black, white, median)
    if (Math.abs(white - before) < 1e-4) break
  }
  // A coarse crop (thumbnail, globe decal) averages away the small bright things that set a photo's white point.
  if (spanGain > 1 && !cloudFrame && white < COARSE_WHITE_MAX) {
    white = Math.min(COARSE_WHITE_MAX, black + (white - black) * spanGain)
    gamma = gammaFor(black, white, median)
  }
  if (stats)
    Object.assign(stats, {
      median,
      whiteL,
      whiteE,
      whiteCap,
      cloudy: cloudFrame,
      groundShare: sets[1].n / all.n,
      use,
    })
  return {
    black: q4(black),
    white: q4(white),
    gamma: Math.round(gamma * 1000) / 1000,
    saturation: SATURATION,
  }
}
const q4 = (v: number) => Math.round(v * 10_000) / 10_000

const NEAR_CLOUD = 1
const NEAR_CIRRUS = 2

/** Cloud (bit 1) and thin-cirrus (bit 2) cells grown by one cell: their bright, unflagged edges stay out of the white point too. */
function cloudNear(m: ToneMask): Uint8Array {
  const out = new Uint8Array(m.w * m.h)
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const c = m.cls[y * m.w + x]
      const f = c === Cell.Cloud ? NEAR_CLOUD : c === Cell.Cirrus ? NEAR_CIRRUS : 0
      if (!f) continue
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= m.h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < m.w) out[yy * m.w + xx] |= f
        }
      }
    }
  }
  return out
}

/** Unsharp-mask radius (Gaussian sigma, output px) for a crop: ~0.6 native px, none on downsampled crops. */
export function sharpenSigma(collection: ToneCollection, metresPerPx: number): number {
  const s = (0.6 * NATIVE_GSD_M[collection]) / metresPerPx
  return s < 0.45 ? 0 : Math.min(2.5, Math.round(s * 100) / 100)
}

export const SHARPEN_AMOUNT = 0.55
/** Luma differences below this (of 255) are left alone, so flat areas keep their grain. */
export const SHARPEN_THRESHOLD = 2
/** …and above this they add no more: no dark or bright rims around clouds and snow lines (≤ 9 levels either way). */
export const SHARPEN_LIMIT = 16

const TONE_STEPS = 4096

/** The brightness curve alone: linear reflectance fraction → display value 0…255 (for tests and docs). */
export function toneCurve(p: ToneParams, x: number): number {
  const t = Math.min(1, Math.max(0, (x - p.black) / (p.white - p.black)))
  return Math.pow(t, p.gamma) * 255
}

function gaussKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma))
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return k
}

/** Rows per step of the cooperative passes below (a 1024 px row band of this height is a few milliseconds). */
const BAND_ROWS = 32

/**
 * Separable blur of `src` (w × h) weighted by `wt` (normalised convolution; `wt` null = all ones). A generator that
 * pauses between row bands (see toneSteps); its return value is the blurred image.
 */
function* blurSteps(src: Float32Array, wt: Float32Array | null, w: number, h: number, k: Float32Array): Generator<void, Float32Array> {
  const tmpV = new Float32Array(w * h)
  const tmpW = wt ? new Float32Array(w * h) : null
  for (let y = 0; y < h; y++) {
    blurRow(src, wt, w, y, k, tmpV, tmpW)
    if (y % BAND_ROWS === BAND_ROWS - 1) yield
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    blurColumnRow(tmpV, tmpW, w, h, y, k, out)
    if (y % BAND_ROWS === BAND_ROWS - 1) yield
  }
  return out
}

/** blurSteps' horizontal pass for row `y` (a plain function: see toneSteps). */
function blurRow(src: Float32Array, wt: Float32Array | null, w: number, y: number, k: Float32Array, tmpV: Float32Array, tmpW: Float32Array | null): void {
  const r = (k.length - 1) >> 1
  const row = y * w
  for (let x = 0; x < w; x++) {
    let a = 0
    let b = 0
    for (let j = -r; j <= r; j++) {
      const xx = x + j < 0 ? 0 : x + j >= w ? w - 1 : x + j
      const kw = k[j + r]
      if (wt) {
        const ww = wt[row + xx] * kw
        a += src[row + xx] * ww
        b += ww
      } else a += src[row + xx] * kw
    }
    tmpV[row + x] = a
    if (tmpW) tmpW[row + x] = b
  }
}

/** blurSteps' vertical pass for output row `y`. */
function blurColumnRow(tmpV: Float32Array, tmpW: Float32Array | null, w: number, h: number, y: number, k: Float32Array, out: Float32Array): void {
  const r = (k.length - 1) >> 1
  for (let x = 0; x < w; x++) {
    let a = 0
    let b = 0
    for (let j = -r; j <= r; j++) {
      const yy = y + j < 0 ? 0 : y + j >= h ? h - 1 : y + j
      const kw = k[j + r]
      a += tmpV[yy * w + x] * kw
      if (tmpW) b += tmpW[yy * w + x] * kw
    }
    out[y * w + x] = tmpW ? (b > 1e-6 ? a / b : 0) : a
  }
}

/** Run a step generator to its end, here and now. */
function runSteps<T>(g: Generator<void, T>): T {
  for (;;) {
    const r = g.next()
    if (r.done) return r.value
  }
}

/**
 * Tone an encoded crop in place (RGBA), the same at every pixel:
 *  1. brightness: the curve on luminance (black, white, gamma), so display luma = curve(L);
 *  2. colour: each channel = curve(L) × (channel / L)^CHROMA (renormalised so luma stays put), then saturation around
 *     luma. The ratios take out only CHROMA_BLACK of the black point: all of it inflated the colour of dark water and
 *     forest (the ratios of the little left above black);
 *  2b. a JPEG source's 8-px compression grid is smoothed in flat areas (deblock8);
 *  3. fit: a pixel whose colour would leave the displayable range keeps its luma and hue and gives up just enough
 *     colour to fit (towards white above, so blown cloud and snow go white, not cream; a channel never goes
 *     negative in shade);
 *  4. a light unsharp mask on luma (sigma in px; 0 = none).
 * No-data pixels (black) stay black.
 *
 * Why luminance and a fixed chroma exponent: a per-channel power with the scene's gamma also raises colour ratios to
 * that gamma, so a bright desert (gamma ~1) would turn orange while a dark city (gamma 0.55) stays natural. With the
 * curve on luminance and CHROMA = 0.55 (the dark scenes' gamma, where the two agree) every scene keeps true hues.
 */
export function applyTone(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, p: ToneParams, sigma: number, jpeg = false): void {
  runSteps(toneSteps(rgba, width, height, p, sigma, jpeg))
}

/** applyTone as a generator that pauses between row bands, so a worker can answer other requests mid-photo. */
export function* toneSteps(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  p: ToneParams,
  sigma: number,
  jpeg = false,
): Generator<void, void> {
  const curve = new Float32Array(TONE_STEPS + 1)
  for (let i = 0; i <= TONE_STEPS; i++) curve[i] = Math.pow(i / TONE_STEPS, p.gamma) * 255
  const n = width * height
  let holes = 0
  const band = BAND_ROWS * width
  const memo: ColourMemo = { keys: new Int32Array(MEMO_SIZE).fill(-1), vals: new Int32Array(MEMO_SIZE) }
  for (let start = 0; start < n; start += band) {
    if (start) yield
    holes += curveBand(rgba, start, Math.min(n, start + band), curve, p, memo)
  }
  if (jpeg) {
    yield
    yield* deblockSteps(rgba, width, height)
  }
  if (!(sigma > 0)) return
  yield
  const Y = new Float32Array(n)
  const valid = new Uint8Array(n)
  for (let start = 0; start < n; start += band) {
    if (start) yield
    lumaBand(rgba, start, Math.min(n, start + band), Y, valid)
  }
  let wt: Float32Array | null = null
  if (holes) {
    wt = new Float32Array(n)
    for (let i = 0; i < n; i++) wt[i] = valid[i]
  }
  yield
  const soft = yield* blurSteps(Y, wt, width, height, gaussKernel(sigma))
  for (let start = 0; start < n; start += band) {
    yield
    sharpenBand(rgba, start, Math.min(n, start + band), Y, soft, valid)
  }
}

/*
 * The per-band work of toneSteps, as plain functions: the generator only decides when to pause. (Hot loops inside a
 * generator body run several times slower in V8; the pixels are the same either way.)
 */

/**
 * Steps 1–3 depend on nothing but a pixel's own (r, g, b) for one photo's curve, and a photo repeats its colours a
 * lot (flat water, fields, roofs, the JPEG's own blocks): each result is remembered in a small direct-mapped table
 * (one slot per hash of the colour, the newest colour wins a shared slot). The pixels are exactly the same.
 */
interface ColourMemo {
  /** 0xRRGGBB of the colour in each slot, -1 = empty */
  keys: Int32Array
  /** its toned 0xRRGGBB */
  vals: Int32Array
}
const MEMO_BITS = 16
const MEMO_SIZE = 1 << MEMO_BITS

/** Steps 1–3 of applyTone on pixels [start, end). Returns how many were no data. */
function curveBand(rgba: Uint8Array | Uint8ClampedArray, start: number, end: number, curve: Float32Array, p: ToneParams, memo: ColourMemo): number {
  const { keys, vals } = memo
  const lin = linTable()
  const lut = ratioTable()
  const black = p.black
  const cb = CHROMA_BLACK * black
  const span = p.white - p.black
  const s = p.saturation
  let holes = 0
  for (let i = start, o = start * 4; i < end; i++, o += 4) {
    const r8 = rgba[o]
    const g8 = rgba[o + 1]
    const b8 = rgba[o + 2]
    if (r8 + g8 + b8 === 0) {
      holes++
      continue
    }
    const key = (r8 << 16) | (g8 << 8) | b8
    const slot = Math.imul(key, 0x9e3779b1) >>> (32 - MEMO_BITS)
    if (keys[slot] === key) {
      const v = vals[slot]
      rgba[o] = v >>> 16
      rgba[o + 1] = (v >>> 8) & 255
      rgba[o + 2] = v & 255
      continue
    }
    const r = lin[r8]
    const g = lin[g8]
    const b = lin[b8]
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const d = L - black
    const ly = d <= 0 ? 0 : curve[Math.round((d >= span ? 1 : d / span) * TONE_STEPS)]
    let R = ly
    let G = ly
    let B = ly
    if (ly > 0 && L - cb > 1e-6) {
      const k = 1 / (L - cb)
      const xr = r > cb ? (r - cb) * k : 0
      const xg = g > cb ? (g - cb) * k : 0
      const xb = b > cb ? (b - cb) * k : 0
      const fr = xr >= RATIO_MAX ? Math.pow(xr, CHROMA) : lut[Math.round(xr * RATIO_STEPS)]
      const fg = xg >= RATIO_MAX ? Math.pow(xg, CHROMA) : lut[Math.round(xg * RATIO_STEPS)]
      const fb = xb >= RATIO_MAX ? Math.pow(xb, CHROMA) : lut[Math.round(xb * RATIO_STEPS)]
      const l = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb
      if (l > 1e-6) {
        const q = s / l
        let kr = 1 - s + fr * q
        let kg = 1 - s + fg * q
        let kb = 1 - s + fb * q
        const kmax = kr > kg ? (kr > kb ? kr : kb) : kg > kb ? kg : kb
        const kmin = kr < kg ? (kr < kb ? kr : kb) : kg < kb ? kg : kb
        let tau = 1
        if (ly * kmax > 255) tau = ly >= 255 ? 0 : (255 - ly) / (ly * (kmax - 1))
        if (kmin < 0 && 1 / (1 - kmin) < tau) tau = 1 / (1 - kmin)
        if (tau < 1) {
          kr = 1 + tau * (kr - 1)
          kg = 1 + tau * (kg - 1)
          kb = 1 + tau * (kb - 1)
        }
        R = ly * kr
        G = ly * kg
        B = ly * kb
      }
    }
    // A toned pixel is never pure black: (0, 0, 0) stays the mark of no data for the steps below.
    const R8 = clamp8(R)
    const G8 = clamp8(G)
    const B8 = clamp8(B)
    const lift = R8 + G8 + B8 === 0 ? 1 : 0
    rgba[o] = R8 + lift
    rgba[o + 1] = G8 + lift
    rgba[o + 2] = B8 + lift
    keys[slot] = key
    vals[slot] = ((R8 + lift) << 16) | ((G8 + lift) << 8) | (B8 + lift)
  }
  return holes
}

/** Luma of the toned pixels [start, end) for the unsharp mask, and which of them carry data. */
function lumaBand(rgba: Uint8Array | Uint8ClampedArray, start: number, end: number, Y: Float32Array, valid: Uint8Array): void {
  for (let i = start, o = start * 4; i < end; i++, o += 4) {
    if (rgba[o] + rgba[o + 1] + rgba[o + 2] === 0) continue
    Y[i] = 0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2]
    valid[i] = 1
  }
}

/** Step 4 of applyTone on pixels [start, end): the unsharp mask, from luma and its blur. */
function sharpenBand(rgba: Uint8Array | Uint8ClampedArray, start: number, end: number, Y: Float32Array, soft: Float32Array, valid: Uint8Array): void {
  for (let i = start, o = start * 4; i < end; i++, o += 4) {
    if (valid[i] === 0) continue
    const d = Y[i] - soft[i]
    if (d < SHARPEN_THRESHOLD && d > -SHARPEN_THRESHOLD) continue
    const add = SHARPEN_AMOUNT * (d > SHARPEN_LIMIT ? SHARPEN_LIMIT : d < -SHARPEN_LIMIT ? -SHARPEN_LIMIT : d)
    rgba[o] = clamp8(rgba[o] + add)
    rgba[o + 1] = clamp8(rgba[o + 1] + add)
    rgba[o + 2] = clamp8(rgba[o + 2] + add)
  }
}

const clamp8 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v))

/** Deblocking: the largest step across an 8-px JPEG block edge that counts as a compression step (display levels)… */
export const DEBLOCK_STEP = 10
/** …when both sides are this flat (the two pixels on each side differ by at most this). */
export const DEBLOCK_FLAT = 3

/**
 * Smooth the compression grid of a JPEG source (the archive's pixels have no such grid): at every 8-px block edge,
 * in each channel, a small step between two flat sides becomes a ramp over the four pixels around the edge. Real
 * edges (a larger step, or texture on either side) are left alone, and so is no data (pure black). Planetary
 * Computer's JPEG keeps smooth water, sea and sand as flat 8 × 8 blocks (and 16 × 16 for colour); the curve's gain
 * would otherwise turn their one- or two-level steps into a visible patchwork. The same rule everywhere.
 */
export function deblock8(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): void {
  runSteps(deblockSteps(rgba, width, height))
}

/** deblock8 as a generator that pauses between row bands (see toneSteps). */
function* deblockSteps(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Generator<void, void> {
  const row = width * 4
  const edge = (a1: number, a0: number, b0: number, b1: number) => {
    // Indices of p1, p0 | q0, q1 (one channel); no data on any of them: skip.
    for (let c = 0; c < 3; c++) {
      const p1 = rgba[a1 + c]
      const p0 = rgba[a0 + c]
      const q0 = rgba[b0 + c]
      const q1 = rgba[b1 + c]
      const d = q0 - p0
      if (d === 0 || d > DEBLOCK_STEP || d < -DEBLOCK_STEP) continue
      if (p1 - p0 > DEBLOCK_FLAT || p0 - p1 > DEBLOCK_FLAT || q1 - q0 > DEBLOCK_FLAT || q0 - q1 > DEBLOCK_FLAT) continue
      // A linear ramp from the p side to the q side: p1 + d/8, p0 + 3d/8, q0 − 3d/8, q1 − d/8.
      rgba[a1 + c] = clamp8(p1 + d / 8)
      rgba[a0 + c] = clamp8(p0 + (3 * d) / 8)
      rgba[b0 + c] = clamp8(q0 - (3 * d) / 8)
      rgba[b1 + c] = clamp8(q1 - d / 8)
    }
  }
  const dark = (o: number) => rgba[o] + rgba[o + 1] + rgba[o + 2] === 0
  for (let y = 0; y < height; y++) {
    if (y % BAND_ROWS === BAND_ROWS - 1) yield
    const r0 = y * row
    for (let x = 8; x + 1 < width; x += 8) {
      const a1 = r0 + (x - 2) * 4
      const a0 = a1 + 4
      const b0 = a0 + 4
      const b1 = b0 + 4
      if (!dark(a1) && !dark(a0) && !dark(b0) && !dark(b1)) edge(a1, a0, b0, b1)
    }
  }
  for (let y = 8; y + 1 < height; y += 8) {
    if (y % (BAND_ROWS * 4) === 0) yield
    for (let x = 0; x < width; x++) {
      const a1 = (y - 2) * row + x * 4
      const a0 = a1 + row
      const b0 = a0 + row
      const b1 = b0 + row
      if (!dark(a1) && !dark(a0) && !dark(b0) && !dark(b1)) edge(a1, a0, b0, b1)
    }
  }
}

export interface ToneCropOptions {
  /** Scale the sharpening radius (1 = as for a photo shown at its own size; the server card's plate uses 0) */
  sharpen?: number
}

/**
 * The whole step for one decoded crop: the shared curve when one is known for this capture and place (`known`), else
 * measured here; then applied. Returns the curve used.
 */
export function toneCrop(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  plan: TonePlan,
  mask: ToneMask | null,
  known?: ToneParams,
  opts: ToneCropOptions = {},
): ToneParams {
  return runSteps(toneCropSteps(rgba, width, height, plan, mask, known, opts))
}

function* toneCropSteps(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  plan: TonePlan,
  mask: ToneMask | null,
  known: ToneParams | undefined,
  opts: ToneCropOptions,
): Generator<void, ToneParams> {
  const params = known ?? measureTone(rgba, width, height, plan.box, plan.ref, mask, undefined, coarseSpanGain(plan.collection, plan.metresPerPx), plan.crs)
  yield
  yield* toneSteps(rgba, width, height, params, (opts.sharpen ?? 1) * sharpenSigma(plan.collection, plan.metresPerPx), plan.jpeg)
  return params
}

/** Work at most this long before pausing (toneCropAsync). */
const SLICE_MS = 12

/**
 * toneCrop, the same pixels, but pausing (`pause`, e.g. one macrotask) every ~12 ms of work: in the pixels worker a
 * 2048 px photo is ~1 s of work on a laptop and several on a phone, and the worker's other requests (cloud masks the
 * engine is waiting for, GIBS checks, thumbnails) must not wait for it.
 */
export async function toneCropAsync(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  plan: TonePlan,
  mask: ToneMask | null,
  known: ToneParams | undefined,
  pause: () => Promise<void>,
  opts: ToneCropOptions = {},
): Promise<ToneParams> {
  const g = toneCropSteps(rgba, width, height, plan, mask, known, opts)
  let t = performance.now()
  for (;;) {
    const r = g.next()
    if (r.done) return r.value
    if (performance.now() - t >= SLICE_MS) {
      await pause()
      t = performance.now()
    }
  }
}
