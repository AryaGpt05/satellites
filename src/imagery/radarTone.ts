/**
 * The radar image's tone (pixels worker, ./pixels.ts): the encoded decibels Planetary Computer sends (./radar.ts) made
 * into the picture every view shows.
 *
 * Each image gets its own contrast, as each photo gets its own curve: what a radar sees varies far more from place to
 * place than sunlight does (calm water is ~−25 dB, fields −15, forest −8, a city's walls and corners above 0), so one
 * fixed scale would leave a desert grey and a city blown out. The stretch runs, in decibels, from the 1st to the 99.6th
 * percentile of the image's data (bright points may clip; they are corners and ships), never over less than 16 dB, so
 * a uniform scene (open sea) stays calm instead of being stretched into speckle. A slight gamma (1.15) keeps the
 * dark ground dark.
 *
 * The ramp is the site's own: ink in the shadows, ice (the design's one colour for radar) faintly in the mid-tones,
 * a cool off-white at the top, never pure white or black. Radar has no colour; the tint only says "this is not a
 * photograph", and the brightness is the backscatter, as measured. No data stays (0, 0, 0), as in every photo.
 */
import { palette } from '@/ui/system/palette'
import { RADAR_DB_MAX, RADAR_DB_MIN } from './radar'

/** Encoded values below this are no data (0, plus a JPEG's ringing at a scene edge); data starts at 17 (−30 dB). */
const DATA_MIN = 12
const LOW_PCT = 0.01
const HIGH_PCT = 0.996
const MIN_SPAN_DB = 16
const GAMMA = 1.15
const DB_PER_STEP = (RADAR_DB_MAX - RADAR_DB_MIN) / 255

type Rgb = [number, number, number]
const rgbOf = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const grey = (v: number): Rgb => [v * 255, v * 255, v * 255]

/** The ramp's stops: ink, a mid-grey a quarter of the way to ice, an off-white an eighth of the way. */
const STOPS: [number, Rgb][] = [
  [0, rgbOf(palette.ink1)],
  [0.6, mix(grey(0.53), rgbOf(palette.ice), 0.25)],
  [1, mix(grey(0.93), rgbOf(palette.ice), 0.12)],
]

function rampAt(t: number): Rgb {
  for (let i = 1; i < STOPS.length; i++) {
    const [x1, c1] = STOPS[i]
    const [x0, c0] = STOPS[i - 1]
    if (t <= x1) return mix(c0, c1, (t - x0) / (x1 - x0))
  }
  return STOPS[STOPS.length - 1][1]
}

/** The encoded value at a share `q` of the data, from its histogram. */
function quantile(hist: Uint32Array, total: number, q: number): number {
  const want = q * total
  let seen = 0
  for (let v = DATA_MIN; v < 256; v++) {
    seen += hist[v]
    if (seen >= want) return v
  }
  return 255
}

/**
 * The stretch of one image, in encoded steps: [low, high], the data's 1st and 99.6th percentiles widened about their
 * middle to at least 16 dB. Null when the image holds no data.
 */
export function radarStretch(hist: Uint32Array): [number, number] | null {
  let total = 0
  for (let v = DATA_MIN; v < 256; v++) total += hist[v]
  if (!total) return null
  let lo = quantile(hist, total, LOW_PCT)
  let hi = quantile(hist, total, HIGH_PCT)
  const minSpan = MIN_SPAN_DB / DB_PER_STEP
  if (hi - lo < minSpan) {
    const mid = quantile(hist, total, 0.5)
    lo = Math.min(lo, mid - minSpan / 2)
    hi = Math.max(hi, mid + minSpan / 2)
  }
  return [lo, hi]
}

/**
 * Tone a decoded radar crop in place (RGBA; the encoded value in the red channel, as a grey JPEG or PNG decodes).
 * Returns the share of its pixels that hold data (0 when none: the caller then has nothing to show).
 */
export function toneRadar(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): number {
  const n = width * height
  if (rgba.length < n * 4) throw new Error('size')
  const hist = new Uint32Array(256)
  for (let o = 0; o < n * 4; o += 4) hist[rgba[o]]++
  const stretch = radarStretch(hist)
  const lut = new Uint8Array(256 * 3)
  if (stretch) {
    const [lo, hi] = stretch
    for (let v = DATA_MIN; v < 256; v++) {
      const t = Math.pow(Math.min(1, Math.max(0, (v - lo) / (hi - lo))), GAMMA)
      const [r, g, b] = rampAt(t)
      // Never (0, 0, 0): that is the mark of no data.
      lut[v * 3] = Math.max(1, Math.round(r))
      lut[v * 3 + 1] = Math.max(1, Math.round(g))
      lut[v * 3 + 2] = Math.max(1, Math.round(b))
    }
  }
  let data = 0
  for (let o = 0; o < n * 4; o += 4) {
    const v = rgba[o]
    rgba[o] = lut[v * 3]
    rgba[o + 1] = lut[v * 3 + 1]
    rgba[o + 2] = lut[v * 3 + 2]
    rgba[o + 3] = 255
    if (v >= DATA_MIN) data++
  }
  return stretch ? data / n : 0
}
