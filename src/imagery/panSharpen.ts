/**
 * Pan-sharpening for Landsat 8/9 (the lightbox's sharper layer, pixels.ts): the toned 30 m colour photo, shown at
 * 1000 px for its 15 km crop (each 30 m pixel 2 × 2), takes the 15 m detail of the same capture's panchromatic band
 * (api/pan: the same crop, 1000 px, 1:1).
 *
 * SFIM (smoothing-filter-based intensity modulation): each pixel's colour, in linear light, is multiplied by
 * pan / lowpass(pan), where the low-pass is the pan band seen at the colour's own 30 m resolution. Where the pan is
 * flat at 30 m the ratio is 1 and the photo is unchanged; within a 30 m pixel it redistributes that pixel's light as
 * the 15 m band saw it. Colour and overall brightness stay the photo's (the ratio averages to 1); only measured detail
 * is added, nothing is invented. The ratio is clamped (a cloud edge, a glint) so a misregistered or saturated pixel
 * can never blow out.
 */

const GAMMA = 2.2
const RATIO_MIN = 0.6
const RATIO_MAX = 1.7

let toLin: Float32Array | null = null
const OUT_STEPS = 4096
let toEnc: Uint8Array | null = null
function luts() {
  if (!toLin || !toEnc) {
    toLin = new Float32Array(256)
    for (let v = 0; v < 256; v++) toLin[v] = Math.pow(v / 255, GAMMA)
    toEnc = new Uint8Array(OUT_STEPS + 1)
    for (let i = 0; i <= OUT_STEPS; i++) toEnc[i] = Math.round(Math.pow(i / OUT_STEPS, 1 / GAMMA) * 255)
  }
  return { toLin, toEnc }
}

/**
 * Separable box mean of side k (2: this pixel and the next; 3: centred), edges clamped, weighted by `w` (0 = no data):
 * the mean of the valid pixels. Written out per side (no inner loop): it runs over a million pixels twice.
 */
function boxMean(src: Float32Array, w: Float32Array, width: number, height: number, k: 2 | 3): { v: Float32Array; w: Float32Array } {
  const n = src.length
  const sw = new Float32Array(n)
  for (let i = 0; i < n; i++) sw[i] = src[i] * w[i]
  const tv = new Float32Array(n)
  const tw = new Float32Array(n)
  for (let y = 0; y < height; y++) {
    const r = y * width
    const last = r + width - 1
    for (let i = r; i <= last; i++) {
      const a = i > r ? i - 1 : r
      const b = i < last ? i + 1 : last
      if (k === 2) {
        tv[i] = sw[i] + sw[b]
        tw[i] = w[i] + w[b]
      } else {
        tv[i] = sw[a] + sw[i] + sw[b]
        tw[i] = w[a] + w[i] + w[b]
      }
    }
  }
  const v = new Float32Array(n)
  const ow = new Float32Array(n)
  for (let y = 0; y < height; y++) {
    const up = (y > 0 ? y - 1 : 0) * width
    const dn = (y < height - 1 ? y + 1 : height - 1) * width
    const r = y * width
    for (let x = 0; x < width; x++) {
      const i = r + x
      const a = k === 2 ? tv[i] + tv[dn + x] : tv[up + x] + tv[i] + tv[dn + x]
      const b = k === 2 ? tw[i] + tw[dn + x] : tw[up + x] + tw[i] + tw[dn + x]
      v[i] = b > 0 ? a / b : 0
      ow[i] = b > 0 ? 1 : 0
    }
  }
  return { v, w: ow }
}

/**
 * Sharpen `rgba` (the toned colour photo, w × h) in place with `pan` (the pan band decoded to RGBA, the same w × h;
 * grey in the red channel, √-encoded reflectance, 0 = no data). Pixels with no data in either stay as they are.
 * Returns the share of pixels the pan band covered (the caller drops a layer that is mostly no data).
 */
export function panSharpen(rgba: Uint8ClampedArray | Uint8Array, pan: Uint8ClampedArray | Uint8Array, width: number, height: number): number {
  const n = width * height
  if (rgba.length < n * 4 || pan.length < n * 4) throw new Error('size')
  const { toLin, toEnc } = luts()
  // The pan as (proportional to) reflectance: the √ encoding squared.
  const P = new Float32Array(n)
  const W = new Float32Array(n)
  let covered = 0
  for (let i = 0; i < n; i++) {
    const v = pan[i * 4]
    if (v > 0) {
      P[i] = (v / 255) * (v / 255)
      W[i] = 1
      covered++
    }
  }
  // The pan at the colour's 30 m: the mean over a 2 × 2 cell, smoothed over 3 × 3 (no blocky cell edges).
  const a = boxMean(P, W, width, height, 2)
  const low = boxMean(a.v, a.w, width, height, 3).v
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    if (!W[i] || low[i] <= 1e-6) continue
    const r8 = rgba[o]
    const g8 = rgba[o + 1]
    const b8 = rgba[o + 2]
    if (r8 + g8 + b8 === 0) continue
    let k = P[i] / low[i]
    k = k < RATIO_MIN ? RATIO_MIN : k > RATIO_MAX ? RATIO_MAX : k
    const xr = toLin[r8] * k
    const xg = toLin[g8] * k
    const xb = toLin[b8] * k
    // Never pure black: (0, 0, 0) stays the mark of no data.
    const R = toEnc[xr >= 1 ? OUT_STEPS : (xr * OUT_STEPS + 0.5) | 0]
    const G = toEnc[xg >= 1 ? OUT_STEPS : (xg * OUT_STEPS + 0.5) | 0]
    const B = toEnc[xb >= 1 ? OUT_STEPS : (xb * OUT_STEPS + 0.5) | 0]
    const lift = R + G + B === 0 ? 1 : 0
    rgba[o] = R + lift
    rgba[o + 1] = G + lift
    rgba[o + 2] = B + lift
  }
  return covered / n
}
