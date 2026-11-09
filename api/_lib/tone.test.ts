import { describe, expect, it } from 'vitest'
import { cardCrop } from './cardSpec.js'
import { makeNpy, maskNpy } from './npyTesting.js'
import {
  BLACK_MAX,
  CHROMA,
  CLOUD_WHITE_MAX,
  COARSE_SPAN_GAIN,
  Cell,
  DEBLOCK_STEP,
  CROP_HALF_KM,
  REF_HALF_KM,
  SHARPEN_AMOUNT,
  SHARPEN_LIMIT,
  applyTone,
  boxAround,
  canShareCurve,
  clearFraction,
  coarseSpanGain,
  deblock8,
  maskBox,
  maskFromNpy,
  maskFromResponse,
  maskUrl,
  measureTone,
  parseNpy,
  pcCropUrlFor,
  pcRenderQuery,
  qaCell,
  s2Offset,
  sclCell,
  sharpenSigma,
  toneCrop,
  toneCropAsync,
  toneCurve,
  tonePlanForUrl,
  type Box,
  type ToneParams,
} from './tone.js'

const S2 = 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803'
const S2_OLD = 'S2A_MSIL2A_20211010T100941_R022_T33UUU_20211010T182053'
const LS = 'LC09_L2SP_019030_20261022_02_T1'
const WATERLOO = { lat: 43.4723, lon: -80.5449 }

describe('the render', () => {
  it('removes the BOA offset from processing baseline 04.00 (generated from 25 Jan 2022) on', () => {
    expect(s2Offset(S2)).toBe(1000)
    expect(s2Offset(S2_OLD)).toBe(0)
    expect(s2Offset('S2B_MSIL2A_20220124T101249_R022_T33UUU_20220124T012007')).toBe(0)
    expect(s2Offset('S2B_MSIL2A_20220126T101249_R022_T33UUU_20220211T193919')).toBe(1000)
    expect(s2Offset('x')).toBe(1000) // no stamp: today's products
    expect(s2Offset(S2_OLD, '04.00')).toBe(1000) // a known baseline decides
    expect(s2Offset(S2, '03.00')).toBe(0)
  })

  it('asks for square-rooted surface reflectance, warped with Lanczos', () => {
    const q = new URLSearchParams(pcRenderQuery('sentinel-2-l2a', S2))
    expect(q.getAll('assets')).toEqual(['B04', 'B03', 'B02'])
    expect(q.get('asset_as_band')).toBe('true')
    expect(q.get('expression')).toBe('sqrt(where(B04>1000,B04-1000,0));sqrt(where(B03>1000,B03-1000,0));sqrt(where(B02>1000,B02-1000,0))')
    expect(q.get('rescale')).toBe('0,100') // sqrt(10000): reflectance 0…1
    expect(q.get('reproject')).toBe('lanczos')
    expect(q.get('nodata')).toBe('0')
    expect(new URLSearchParams(pcRenderQuery('sentinel-2-l2a', S2_OLD)).get('expression')).toContain('sqrt(where(B04>0,B04-0,0))')
    const l = new URLSearchParams(pcRenderQuery('landsat-c2-l2', LS))
    expect(l.getAll('assets')).toEqual(['red', 'green', 'blue'])
    expect(l.get('expression')).toBe('sqrt(where(red>7272.727,red-7272.727,0));sqrt(where(green>7272.727,green-7272.727,0));sqrt(where(blue>7272.727,blue-7272.727,0))')
    expect(l.get('rescale')).toBe('0,190.693') // sqrt(1 / 2.75e-5)
    expect(l.get('reproject')).toBe('lanczos')
  })

  it('builds crop URLs the plan can read back', () => {
    const box = boxAround(WATERLOO.lat, WATERLOO.lon, 5)
    const url = pcCropUrlFor('sentinel-2-l2a', S2, box, 1024, 'jpg')
    expect(url).toMatch(/^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/-80\.6\d+,43\.42\d+,-80\.4\d+,43\.51\d+\/1024x1024\.jpg\?collection=sentinel-2-l2a&item=/)
    const plan = tonePlanForUrl(url)!
    expect(plan.collection).toBe('sentinel-2-l2a')
    expect(plan.itemId).toBe(S2)
    expect([plan.lat, plan.lon]).toEqual([43.47, -80.54])
    expect(plan.metresPerPx).toBeCloseTo(9.77, 2)
    expect(plan.maskUrl).toBe(maskUrl('sentinel-2-l2a', S2, 43.47, -80.54))
    expect(plan.ref).toEqual(boxAround(43.47, -80.54, 3.15))
    expect(plan.key).toBe(`sentinel-2-l2a|${S2}|43.47,-80.54`)
    expect(canShareCurve(plan)).toBe(true)
    // Thumbnails and globe decals are too coarse to set the shared curve.
    expect(canShareCurve(tonePlanForUrl(pcCropUrlFor('sentinel-2-l2a', S2, box, 112, 'jpg'))!)).toBe(false)
    // Not an encoded render: GIBS, the old TCI recipe, an Earth Search thumbnail.
    expect(tonePlanForUrl('https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS')).toBeNull()
    expect(tonePlanForUrl(url.replace(/&asset_as_band.*$/, '&assets=visual'))).toBeNull()
  })

  it('measures the card, the app photo and the server crop over the same square', () => {
    // The share card's crop (cardSpec) is the measuring square, and it fits inside the app's photo.
    expect(REF_HALF_KM['sentinel-2-l2a']).toBe(cardCrop({ collection: 'sentinel-2-l2a', itemId: S2 }).halfSizeKm)
    expect(REF_HALF_KM['landsat-c2-l2']).toBe(cardCrop({ collection: 'landsat-c2-l2', itemId: LS }).halfSizeKm)
    for (const c of ['sentinel-2-l2a', 'landsat-c2-l2'] as const) expect(REF_HALF_KM[c] + 0.8).toBeLessThan(CROP_HALF_KM[c]) // 0.005° rounding ≤ 0.8 km
    // The app's crop (exact point) and the server's (rounded point) derive one mask and one key.
    const app = tonePlanForUrl(pcCropUrlFor('sentinel-2-l2a', S2, boxAround(WATERLOO.lat, WATERLOO.lon, 5), 1024, 'jpg'))!
    const server = tonePlanForUrl(pcCropUrlFor('sentinel-2-l2a', S2, boxAround(43.47, -80.54, 3.15), 630, 'jpg'))!
    expect(server.maskUrl).toBe(app.maskUrl)
    expect(server.key).toBe(app.key)
    expect(server.ref).toEqual(app.ref)
    expect(server.metresPerPx).toBeCloseTo(10, 1)
  })
})

describe('the mask', () => {
  it('parses numpy files', () => {
    const npy = parseNpy(makeNpy([2, 3], '<u2', [1, 2, 3, 400, 500, 65535]))
    expect(npy.shape).toEqual([2, 3])
    expect([...npy.data]).toEqual([1, 2, 3, 400, 500, 65535])
    expect([...parseNpy(makeNpy([4], '|u1', [9, 8, 7, 6])).data]).toEqual([9, 8, 7, 6])
    expect(() => parseNpy(new Uint8Array([1, 2, 3]))).toThrow()
  })

  it('parses a Node Buffer that is a view into a larger pool (CT-9)', () => {
    const file = makeNpy([2, 3], '<u2', [1, 2, 3, 400, 500, 65535])
    const pool = Buffer.alloc(file.length + 37)
    Buffer.from(file).copy(pool, 37)
    const view = pool.subarray(37) // byteOffset 37: Buffer#slice would hand the header back as data
    expect([...parseNpy(view).data]).toEqual([1, 2, 3, 400, 500, 65535])
  })

  it('classifies SCL and QA_PIXEL', () => {
    expect([0, 1, 3, 4, 5, 6, 8, 9, 10, 11].map(sclCell)).toEqual([
      Cell.NoData,
      Cell.NoData,
      Cell.Shadow,
      Cell.Clear,
      Cell.Clear,
      Cell.Clear,
      Cell.Cloud,
      Cell.Cloud,
      Cell.Cirrus,
      Cell.Clear,
    ])
    expect(qaCell(21824)).toBe(Cell.Clear) // measured at Waterloo: clear
    expect(qaCell(22280)).toBe(Cell.Cloud) // bit 3
    expect(qaCell(1)).toBe(Cell.NoData)
    expect(qaCell(1 << 1)).toBe(Cell.Cloud) // dilated
    expect(qaCell(1 << 2)).toBe(Cell.Cloud) // cirrus band: cloud, as the spot check says (cloud.ts classifyQaPixel)
    expect(qaCell(1 << 4)).toBe(Cell.Shadow)
  })

  it('reads the clear share of the square: cloud and shadow 0, thin cirrus ½, no data left out', () => {
    const box = maskBox('sentinel-2-l2a', WATERLOO.lat, WATERLOO.lon)
    const half = maskFromNpy('sentinel-2-l2a', box, parseNpy(maskNpy(10, 10, (x) => (x < 5 ? 4 : 9))))
    expect(clearFraction(half)).toBe(0.5)
    const cirrus = maskFromNpy('sentinel-2-l2a', box, parseNpy(maskNpy(10, 10, () => 10)))
    expect(clearFraction(cirrus)).toBe(0.5)
    const edge = maskFromNpy('sentinel-2-l2a', box, parseNpy(maskNpy(10, 10, () => 4, (x) => x < 3)))
    expect(clearFraction(edge)).toBeUndefined() // under half the square has data
    const url = maskUrl('landsat-c2-l2', LS, WATERLOO.lat, WATERLOO.lon)
    expect(url).toContain('/64x64.npy?collection=landsat-c2-l2&item=LC09_L2SP_019030_20261022_02_T1&assets=qa_pixel')
    const ls = maskFromResponse(url, maskNpy(64, 64, (x, y) => (y < 16 ? 22280 : 21824)))
    maskBox('landsat-c2-l2', 43.47, -80.54).forEach((v, i) => expect(ls.box[i]).toBeCloseTo(v, 6))
    expect(clearFraction(ls)).toBe(0.75)
  })
})

// ── the curve ─────────────────────────────────────────────────────────────────────────────

/** An encoded crop (sqrt of reflectance) from a reflectance function, RGBA. */
function crop(w: number, h: number, refl: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = refl(x, y)
      const i = (y * w + x) * 4
      px[i] = Math.round(Math.sqrt(Math.max(0, r)) * 255)
      px[i + 1] = Math.round(Math.sqrt(Math.max(0, g)) * 255)
      px[i + 2] = Math.round(Math.sqrt(Math.max(0, b)) * 255)
      px[i + 3] = 255
    }
  return px
}

const BOX: Box = [0, 0, 1, 1]
/** A smooth ramp of grey reflectance 0.01…0.31 with a little colour. */
const city = (x: number, y: number): [number, number, number] => {
  const v = 0.01 + 0.3 * ((x + y * 64) / (64 * 64))
  return [v * 1.1, v, v * 0.8]
}

describe('measureTone', () => {
  it('puts the black point at the darkest channel, the white point at the bright end, and lifts a dark scene', () => {
    const p = measureTone(crop(64, 64, city), 64, 64, BOX, BOX)
    expect(p.black).toBeGreaterThan(0.005)
    expect(p.black).toBeLessThan(0.012)
    expect(p.white).toBeGreaterThan(0.28)
    expect(p.white).toBeLessThan(0.36) // a little above the brightest luminance: room for the red channel
    expect(p.gamma).toBeGreaterThanOrEqual(0.55)
    expect(p.gamma).toBeLessThanOrEqual(0.8)
    expect(p.saturation).toBe(1.2)
  })

  it('leaves clouds out of the white point (with their edges) when the mask marks them', () => {
    // Left 16 columns: bright cloud (reflectance 0.8); the rest: the city ramp.
    const px = crop(64, 64, (x, y) => (x < 16 ? [0.8, 0.8, 0.82] : city(x, y)))
    const noMask = measureTone(px, 64, 64, BOX, BOX)
    const mask = maskFromNpy('sentinel-2-l2a', BOX, parseNpy(maskNpy(8, 8, (x) => (x < 2 ? 9 : 4))))
    const withMask = measureTone(px, 64, 64, BOX, BOX, mask)
    expect(noMask.white).toBeGreaterThan(0.75)
    expect(withMask.white).toBeLessThan(0.36)
  })

  it('exposes a frame of cloud for the cloud: black point capped, white point capped, no purple or murk (P1-1)', () => {
    // An overcast deck at reflectance 0.53…0.74 with a faint blue cast, all of it SCL cloud (Reykjavik 7 Nov).
    const deck = crop(64, 64, (x, y) => {
      const v = 0.53 + 0.21 * (((x * 7 + y * 3) % 64) / 64)
      return [v, v * 1.01, v * 1.04]
    })
    const mask = maskFromNpy('sentinel-2-l2a', BOX, parseNpy(maskNpy(8, 8, () => 9)))
    for (const m of [mask, null]) {
      const p = measureTone(deck, 64, 64, BOX, BOX, m)
      expect(p.black).toBeLessThanOrEqual(BLACK_MAX)
      expect(p.white - p.black).toBeGreaterThan(0.35)
      expect(p.white).toBeLessThanOrEqual(m ? CLOUD_WHITE_MAX : 1)
      const px = deck.slice()
      applyTone(px, 64, 64, p, 0)
      let lo = 255
      let cast = 0
      for (let i = 0; i < px.length; i += 4) {
        lo = Math.min(lo, px[i], px[i + 1], px[i + 2])
        cast = Math.max(cast, px[i + 2] - px[i])
      }
      expect(lo).toBeGreaterThan(150) // a light deck, no black corner
      expect(cast).toBeLessThan(20) // no blue / purple cast
    }
  })

  it('reads SCL thin cirrus over the whole ground as ground, not as a frame of cloud (Waterloo 1 Nov)', () => {
    const px = crop(64, 64, city)
    const cirrus = maskFromNpy('sentinel-2-l2a', BOX, parseNpy(maskNpy(8, 8, () => 10)))
    const p = measureTone(px, 64, 64, BOX, BOX, cirrus)
    expect(p).toEqual(measureTone(px, 64, 64, BOX, BOX))
  })

  it('sets the white point so a bright colourful ground keeps its red channel (P1-3)', () => {
    // Red sand: r/L ≈ 1.5 (Erg Chebbi), luminance 0.15…0.32 in a bell (two uniforms averaged), a few dark rocks.
    const sand = crop(64, 64, (x, y) => {
      if ((x * 13 + y * 7) % 50 === 0) return [0.03, 0.025, 0.02]
      const i = x + y * 64
      const L = 0.15 + 0.17 * (((i * 37) % 4096) / 4096 + ((i * 1031) % 4096) / 4096) / 2
      return [L * 1.5, L * 0.86, L * 0.5]
    })
    const p = measureTone(sand, 64, 64, BOX, BOX)
    applyTone(sand, 64, 64, p, 0)
    let clipped = 0
    for (let i = 0; i < sand.length; i += 4) if (sand[i] >= 255) clipped++
    expect(clipped / (64 * 64)).toBeLessThan(0.02)
  })

  it('widens a coarse crop’s span (thumbnails read a low white point), but never for cloud or snow', () => {
    expect(coarseSpanGain('sentinel-2-l2a', 9.77)).toBe(1)
    expect(coarseSpanGain('sentinel-2-l2a', 89)).toBeCloseTo(COARSE_SPAN_GAIN, 6)
    expect(coarseSpanGain('sentinel-2-l2a', 39)).toBeGreaterThan(1)
    expect(coarseSpanGain('sentinel-2-l2a', 39)).toBeLessThan(COARSE_SPAN_GAIN)
    const px = crop(64, 64, city)
    const a = measureTone(px, 64, 64, BOX, BOX)
    const b = measureTone(px, 64, 64, BOX, BOX, null, undefined, COARSE_SPAN_GAIN)
    expect(b.white - b.black).toBeCloseTo((a.white - a.black) * COARSE_SPAN_GAIN, 3)
    const deck = crop(64, 64, () => [0.7, 0.7, 0.72])
    const cloud = maskFromNpy('sentinel-2-l2a', BOX, parseNpy(maskNpy(8, 8, () => 9)))
    expect(measureTone(deck, 64, 64, BOX, BOX, cloud, undefined, COARSE_SPAN_GAIN)).toEqual(measureTone(deck, 64, 64, BOX, BOX, cloud))
  })

  it('measures over the reference square only', () => {
    // Bright outside the centre square, dark city inside it.
    const px = crop(64, 64, (x, y) => (x >= 16 && x < 48 && y >= 16 && y < 48 ? city(x, y) : [0.9, 0.9, 0.9]))
    const ref: Box = [0.25, 0.25, 0.75, 0.75]
    expect(measureTone(px, 64, 64, BOX, ref).white).toBeLessThan(0.33)
    expect(measureTone(px, 64, 64, BOX, BOX).white).toBeGreaterThan(0.85)
  })

  it('is neutral on an empty crop', () => {
    expect(measureTone(new Uint8ClampedArray(16 * 16 * 4), 16, 16, BOX, BOX)).toEqual({ black: 0, white: 0.35, gamma: 0.8, saturation: 1.2 })
  })
})

describe('applyTone', () => {
  const p: ToneParams = { black: 0.01, white: 0.3, gamma: 0.6, saturation: 1.2 }

  it('is global: equal pixels come out equal, wherever they are (no sharpening)', () => {
    const px = crop(32, 32, (x, y) => ((x * 7 + y * 13) % 3 === 0 ? [0.05, 0.06, 0.04] : [0.2, 0.18, 0.12]))
    applyTone(px, 32, 32, p, 0)
    const seen = new Map<string, string>()
    for (let i = 0; i < px.length; i += 4) {
      const out = `${px[i]},${px[i + 1]},${px[i + 2]}`
      const key = String((((i >> 2) % 32) * 7 + Math.floor(i / 4 / 32) * 13) % 3 === 0)
      if (seen.has(key)) expect(out).toBe(seen.get(key))
      else seen.set(key, out)
    }
  })

  it('maps grey through the brightness curve, keeps no-data black and is monotonic', () => {
    const greys = [0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5]
    const px = crop(greys.length, 1, (x) => [greys[x], greys[x], greys[x]])
    px[0] = px[1] = px[2] = 0 // no data
    applyTone(px, greys.length, 1, p, 0)
    expect([px[0], px[1], px[2]]).toEqual([0, 0, 0])
    for (let x = 1; x < greys.length; x++) {
      const v = px[x * 4]
      expect(Math.abs(v - toneCurve(p, (Math.round(Math.sqrt(greys[x]) * 255) / 255) ** 2))).toBeLessThanOrEqual(1)
      expect(v).toBeGreaterThanOrEqual(px[(x - 1) * 4])
      expect(px[x * 4 + 1]).toBe(v) // grey stays grey
    }
    expect(px[(greys.length - 1) * 4]).toBe(255) // above the white point
  })

  it('keeps hue: colour ratios follow CHROMA, not the scene gamma', () => {
    const bright: ToneParams = { black: 0, white: 0.5, gamma: 0.8, saturation: 1 }
    const px = crop(1, 1, () => [0.3, 0.2, 0.1])
    applyTone(px, 1, 1, bright, 0)
    const ratio = px[0] / px[2]
    expect(ratio).toBeGreaterThan(0.9 * 3 ** CHROMA)
    expect(ratio).toBeLessThan(1.1 * 3 ** CHROMA)
  })

  it('sharpens edges a little and leaves flat areas alone', () => {
    const edge = crop(16, 16, (x) => (x < 8 ? [0.05, 0.05, 0.05] : [0.2, 0.2, 0.2]))
    const flat = crop(16, 16, () => [0.1, 0.1, 0.1])
    const a = edge.slice()
    const b = edge.slice()
    applyTone(a, 16, 16, p, 0)
    applyTone(b, 16, 16, p, 1)
    const at = (d: Uint8ClampedArray, x: number) => d[(8 * 16 + x) * 4]
    expect(at(b, 7)).toBeLessThan(at(a, 7)) // dark side of the edge darker
    expect(at(b, 8)).toBeGreaterThan(at(a, 8)) // bright side brighter
    expect(at(b, 2)).toBe(at(a, 2)) // away from the edge: untouched
    // A hard edge (cloud on dark ground): the overshoot is capped, so no dark or bright rim.
    const hard = crop(16, 16, (x) => (x < 8 ? [0.02, 0.02, 0.02] : [0.6, 0.6, 0.6]))
    const h0 = hard.slice()
    const h1 = hard.slice()
    applyTone(h0, 16, 16, { ...p, white: 0.9 }, 0)
    applyTone(h1, 16, 16, { ...p, white: 0.9 }, 1.2)
    for (let i = 0; i < h0.length; i += 4) expect(Math.abs(h1[i] - h0[i])).toBeLessThanOrEqual(Math.ceil(SHARPEN_AMOUNT * SHARPEN_LIMIT))
    const f1 = flat.slice()
    const f2 = flat.slice()
    applyTone(f1, 16, 16, p, 0)
    applyTone(f2, 16, 16, p, 1)
    expect([...f2]).toEqual([...f1])
  })

  it('fits colour that would leave the screen by giving up colour, not hue or brightness: blown cloud goes white', () => {
    // A cream cloud above the white point, and a saturated pixel whose weak channel saturation would push below 0.
    const px = crop(2, 1, (x) => (x === 0 ? [0.62, 0.6, 0.5] : [0.02, 0.12, 0.03]))
    applyTone(px, 2, 1, { black: 0.02, white: 0.3, gamma: 0.6, saturation: 1.2 }, 0)
    expect([px[0], px[1], px[2]]).toEqual([255, 255, 255])
    expect(px[4]).toBeGreaterThan(0) // the red of dark forest is not crushed to 0
  })

  it('takes only half the black point out of colour ratios, so dark ground keeps its own colour (P2-1)', () => {
    // Dark forest (r 0.03, g 0.06, b 0.04) under a black point of 0.025.
    const px = crop(1, 1, () => [0.03, 0.06, 0.04])
    applyTone(px, 1, 1, { black: 0.025, white: 0.3, gamma: 0.6, saturation: 1.2 }, 0)
    expect(px[0]).toBeGreaterThan(0)
    expect(px[1] / px[0]).toBeLessThan(2.2) // all of the black taken out made it ≈ 3.3 (teal forest)
  })

  it('smooths the 8-px JPEG grid in flat areas only', () => {
    const W = 24
    const img = new Uint8ClampedArray(W * 4 * 4)
    // Row pattern: flat 100 up to x = 7, flat 104 from x = 8 (a compression step); a real edge at x = 16 (40 levels).
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < W; x++) {
        const v = x < 8 ? 100 : x < 16 ? 104 : 144
        img.set([v, v, v, 255], (y * W + x) * 4)
      }
    const before = img.slice()
    deblock8(img, W, 4)
    const at = (d: Uint8ClampedArray, x: number) => d[x * 4]
    expect([at(img, 6), at(img, 7), at(img, 8), at(img, 9)]).toEqual([101, 102, 103, 104]) // a ramp
    expect(at(img, 15)).toBe(at(before, 15)) // the real edge is left alone
    expect(at(img, 16)).toBe(at(before, 16))
    expect(DEBLOCK_STEP).toBeLessThan(40)
    // No data next to the grid is left alone.
    const nd = before.slice()
    nd.set([0, 0, 0, 255], 7 * 4)
    const nd0 = nd.slice()
    deblock8(nd, W, 4)
    expect([at(nd, 6), at(nd, 7), at(nd, 8)]).toEqual([at(nd0, 6), 0, at(nd0, 8)])
  })

  it('can pause between row bands (the pixels worker) and still give exactly the same pixels (CT-5)', async () => {
    const N = 768
    const url = pcCropUrlFor('sentinel-2-l2a', S2, boxAround(WATERLOO.lat, WATERLOO.lon, 5), N, 'jpg')
    const plan = { ...tonePlanForUrl(url)!, metresPerPx: 9.77 } // sharpened, as a card is
    const src = crop(N, N, (x, y) => city(x % 64, y % 64))
    const a = src.slice()
    const b = src.slice()
    const pa = toneCrop(a, N, N, plan, null)
    let pauses = 0
    const pb = await toneCropAsync(b, N, N, plan, null, undefined, async () => {
      pauses++
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(pb).toEqual(pa)
    expect([...b]).toEqual([...a])
    expect(pauses).toBeGreaterThan(2)
  })

  it('sharpens around 0.6 native pixels, and never downsampled crops', () => {
    expect(sharpenSigma('sentinel-2-l2a', 9.77)).toBeCloseTo(0.61, 2)
    expect(sharpenSigma('sentinel-2-l2a', 4.88)).toBeCloseTo(1.23, 2)
    expect(sharpenSigma('landsat-c2-l2', 20)).toBeCloseTo(0.9, 2)
    expect(sharpenSigma('sentinel-2-l2a', 89)).toBe(0)
  })
})
