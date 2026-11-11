/**
 * NASA GIBS's "Clean Infrared" layers on one grey scale.
 *
 * The layer shows cloud-top temperature: warm ground dark, cold cloud light, on a grey ramp that stops at level 204.
 * Anything colder is drawn in a rainbow instead (cyan, blue, green, yellow, red, then down to black), the forecaster's
 * "enhanced" palette. Over the tropics at night that is a tenth of the picture in neon (measured 2026-11-11, Jakarta:
 * 11.8 % of pixels), which reads as a weather-TV graphic, not as a photograph beside the others (docs/DESIGN.md: no
 * neon, one signal colour).
 *
 * So the colour-coded pixels are put back on the grey scale, above the ramp: the further along the rainbow, the
 * colder, the lighter (205–255). Order is kept and no detail is invented or dropped; only the colour coding goes.
 * The exact temperatures behind each colour are not published with the layer, so the steps above 204 are even ones.
 *
 * The palette was read off a lossless render: straight lines between the stops below. A JPEG smears colour across
 * neighbouring pixels (and the darkest stops keep little of it), so a pixel is read by its nearest point on the
 * rainbow as soon as it shows any colour, eased in over a narrow band so the ramp's own JPEG noise stays grey.
 * (Weighing "how grey" against "how close to the rainbow" instead left a dark ring around every storm top.)
 * The rainbow's last steps towards black cannot be told from warm, dark ground by colour alone; they are the very
 * coldest tops, a few pixels in the core of the deepest storms, and stay dark there.
 *
 * Lives in api/_lib because the share card's renderer redraws the same frames (./imagery.ts); the app imports it
 * through src/imagery/infrared.ts.
 */
/** True for a NASA GIBS image of a Clean Infrared layer (Himawari's is its night frame). */
export const isEnhancedInfraredUrl = (url: string) => url.startsWith('https://gibs.earthdata.nasa.gov/wms/') && /[?&]LAYERS=[^&]*_Clean_Infrared(&|$)/.test(url)

/** The rainbow's stops, coldest last. */
const STOPS: readonly (readonly [number, number, number])[] = [
  [0, 255, 255],
  [0, 0, 115],
  [0, 255, 0],
  [255, 255, 0],
  [255, 0, 0],
  [0, 0, 0],
]
/** The grey ramp's top, and the white the coldest cloud reaches. */
const RAMP_TOP = 205
const COLDEST = 255
/** Below this spread between channels a pixel is grey (JPEG noise on the ramp is well under it)… */
const GREY_SPREAD = 16
/** …and from this spread on it is read off the rainbow alone. */
const COLOUR_SPREAD = 40

/** Where on the rainbow (0 = its warm end, 1 = its coldest) a colour sits: its nearest point. */
function onRainbow(r: number, g: number, b: number): number {
  let best = Infinity
  let at = 0
  for (let i = 0; i + 1 < STOPS.length; i++) {
    const [ar, ag, ab] = STOPS[i]
    const [br, bg, bb] = STOPS[i + 1]
    const dr = br - ar
    const dg = bg - ag
    const db = bb - ab
    const f = Math.max(0, Math.min(1, ((r - ar) * dr + (g - ag) * dg + (b - ab) * db) / (dr * dr + dg * dg + db * db)))
    const d = Math.hypot(r - ar - f * dr, g - ag - f * dg, b - ab - f * db)
    if (d < best) {
      best = d
      at = (i + f) / (STOPS.length - 1)
    }
  }
  return at
}

/** Redraw an enhanced-infrared image in grey, in place (RGBA; alpha untouched). */
export function greyInfrared(rgba: Uint8ClampedArray | Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    const grey = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
    let v = grey
    const spread = Math.max(r, g, b) - Math.min(r, g, b)
    if (spread > GREY_SPREAD) {
      const w = Math.min(1, (spread - GREY_SPREAD) / (COLOUR_SPREAD - GREY_SPREAD))
      v = Math.round(grey + (RAMP_TOP + onRainbow(r, g, b) * (COLDEST - RAMP_TOP) - grey) * w)
    }
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v
  }
}
