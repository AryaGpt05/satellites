/**
 * Crops on the place's UTM grid (toneRender.ts): one grid per place (the zone of the rounded place, as MGRS draws
 * it), the box snapped to that grid's pixel corners, the URL Planetary Computer copies 1:1 for a scene on it, the
 * tone plan read back from it (key and measuring square on the grid, the mask in lon/lat), and the lon/lat mask read
 * from a crop on the grid.
 */
import { describe, expect, it } from 'vitest'
import { maskNpy } from './npyTesting.js'
import {
  CARD_NATIVE_PX,
  PHOTO_NATIVE_PX,
  boxAround,
  canShareCurve,
  cropCrs,
  gridFromStac,
  maskCellAtLatLon,
  maskFromResponse,
  maskKeyForUrl,
  maskUrl,
  maskPoint,
  measureTone,
  nativeBox,
  nativeCentre,
  northInCropDeg,
  parseNpy,
  pcCropUrlAt,
  pcCropUrlFor,
  pcNativeCropUrlFor,
  placeGrid,
  placeInCrop,
  placeZone,
  round2,
  s2GridFromItemId,
  sceneOnPlaceGrid,
  toMaskCrs,
  tonePlanForUrl,
  type Box,
  type NativeGrid,
} from './tone.js'
import { gridBearingOfNorthDeg, utmForward, utmInverse } from './utm.js'

const S2 = 'S2A_MSIL2A_20261105T101121_R022_T33UUU_20261105T164009'
const S2_SYD = 'S2B_MSIL2A_20261105T235229_R130_T56HLH_20261106T012325'
const LS = 'LC09_L2SP_089084_20261101_02_T1'
const BERLIN = { lat: 52.52, lon: 13.405 }
const G33: NativeGrid = { epsg: 32633, gsd: 10, ox: 0, oy: 0 }
/** Landsat over Sydney: UTM 56 NORTH with negative northings, corners 15 m off the 30 m lattice (STAC proj:transform). */
const GLS: NativeGrid = { epsg: 32656, gsd: 30, ox: 15, oy: 15 }
const SYDNEY = { lat: -33.8688, lon: 151.2093 }

function rng(seed: number) {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
}

describe('the scene’s grid', () => {
  it('reads a Sentinel-2 tile id: zone and hemisphere from the MGRS tile, 10 m corners', () => {
    expect(s2GridFromItemId(S2)).toEqual(G33)
    expect(s2GridFromItemId(S2_SYD)).toEqual({ epsg: 32756, gsd: 10, ox: 0, oy: 0 }) // band H: south
    expect(s2GridFromItemId('S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803')!.epsg).toBe(32617) // band T: north
    expect(s2GridFromItemId('S2B_MSIL2A_20261108T101139_R022_T33XVG_20261108T143347')!.epsg).toBe(32633) // Svalbard
    expect(s2GridFromItemId('LC09_L2SP_089084_20261101_02_T1')).toBeNull()
  })
  it('reads STAC proj:* (code or epsg; the band’s transform, else the item’s) and refuses non-UTM or rotated grids', () => {
    const s2Assets = { B04: { 'proj:transform': [10, 0, 300000, 0, -10, 5900040] } }
    expect(gridFromStac('sentinel-2-l2a', { 'proj:epsg': 32633 }, s2Assets)).toEqual(G33)
    expect(gridFromStac('sentinel-2-l2a', { 'proj:code': 'EPSG:32633' }, s2Assets)).toEqual(G33)
    expect(gridFromStac('landsat-c2-l2', { 'proj:epsg': 32656, 'proj:transform': [30, 0, 235785, 0, -30, -3715185] })).toEqual(GLS)
    expect(gridFromStac('landsat-c2-l2', { 'proj:epsg': 3031, 'proj:transform': [30, 0, 15, 0, -30, 15] })).toBeNull()
    expect(gridFromStac('landsat-c2-l2', { 'proj:epsg': 32656, 'proj:transform': [30, 0.1, 15, 0, -30, 15] })).toBeNull()
    expect(gridFromStac('sentinel-2-l2a', { 'proj:epsg': 32633 }, { B04: { 'proj:transform': [20, 0, 0, 0, -20, 0] } })).toBeNull()
    expect(gridFromStac('landsat-c2-l2', {})).toBeNull()
  })
})

describe('the place’s grid', () => {
  it('is the UTM zone of the rounded place, with MGRS’s Norway and Svalbard exceptions', () => {
    expect(placeZone(52.52, 13.405)).toBe(33)
    expect(placeZone(59.33, 17.996)).toBe(34) // rounds to 18.00: zone 34 for the photo and the card alike
    expect(placeZone(59.33, 17.994)).toBe(33)
    expect(placeZone(60.39, 5.32)).toBe(32) // Bergen: 32V (Sentinel-2 has only 32VKN there)
    expect(placeZone(60.39, 2.5)).toBe(31)
    expect(placeZone(78.5, 10.5)).toBe(33) // Svalbard: 33X spans 9–21° E
    expect(placeZone(79, 8.5)).toBe(31)
    expect(placeZone(51.507, -0.128)).toBe(30)
    expect(placeZone(84.2, 10)).toBeNull() // UPS
    expect(placeZone(-80.2, 10)).toBeNull()
  })
  it('is on the collection’s lattice, as its scenes in that zone are delivered', () => {
    expect(placeGrid('sentinel-2-l2a', BERLIN.lat, BERLIN.lon)).toEqual(G33)
    expect(placeGrid('sentinel-2-l2a', SYDNEY.lat, SYDNEY.lon)).toEqual({ epsg: 32756, gsd: 10, ox: 0, oy: 0 }) // south: 327zz
    expect(placeGrid('landsat-c2-l2', SYDNEY.lat, SYDNEY.lon)).toEqual(GLS) // Landsat: 326zz, negative northings
    expect(placeGrid('landsat-c2-l2', -77.85, 166.67)).toEqual({ epsg: 32658, gsd: 30, ox: 15, oy: 15 }) // McMurdo (scene in EPSG:3031)
    expect(placeGrid('sentinel-2-l2a', 85, 10)).toBeNull()
  })
  it('knows which scenes are on it (their crops are copied 1:1)', () => {
    expect(sceneOnPlaceGrid(32633, BERLIN.lat, BERLIN.lon)).toBe(true)
    expect(sceneOnPlaceGrid(32634, 59.33, 18.07)).toBe(true)
    expect(sceneOnPlaceGrid(32633, 59.33, 18.07)).toBe(false)
    expect(sceneOnPlaceGrid(32656, SYDNEY.lat, SYDNEY.lon)).toBe(true) // Landsat's north zone in the south: same zone
    expect(sceneOnPlaceGrid(3031, -77.85, 166.67)).toBe(false)
    expect(sceneOnPlaceGrid(undefined, BERLIN.lat, BERLIN.lon)).toBe(false)
  })
  it('turns every photo of a place the same way, whichever zone its scene is in (Stockholm, at zone 33’s edge)', () => {
    const at = { lat: 59.33, lon: 18.07 }
    const a = pcCropUrlAt('sentinel-2-l2a', 'S2A_MSIL2A_20261105T101121_R022_T34VCL_20261105T145605', at.lat, at.lon, 5, 1000, 'jpg')
    const b = pcCropUrlAt('sentinel-2-l2a', 'S2A_MSIL2A_20261105T101121_R022_T33VXF_20261105T145605', at.lat, at.lon, 5, 1000, 'jpg')
    const c = pcCropUrlAt('landsat-c2-l2', 'LC09_L2SP_192019_20261103_02_T1', at.lat, at.lon, 7.5, 1000, 'jpg')
    for (const u of [a, b, c]) expect(cropCrs(u)).toBe(32634)
    expect(northInCropDeg(a)).toBeCloseTo(northInCropDeg(b), 9)
    expect(Math.abs(northInCropDeg(c) - northInCropDeg(a))).toBeLessThan(0.01)
  })
})

describe('nativeBox', () => {
  it('is whole native pixels on the scene’s corners, the place within half a pixel of its centre', () => {
    const r = rng(3)
    for (let i = 0; i < 500; i++) {
      const lat = 50 + r() * 4
      const lon = 12 + r() * 6
      const b = nativeBox(G33, lat, lon, 1000)
      expect(b.every((v) => Number.isInteger(v) && v % 10 === 0)).toBe(true)
      expect([b[2] - b[0], b[3] - b[1]]).toEqual([10_000, 10_000])
      const [x, y] = utmForward(32633, lat, lon)
      const dx = (x - (b[0] + b[2]) / 2) / 10
      const dy = (y - (b[1] + b[3]) / 2) / 10
      // ≤ 0.5 px on each axis, except the rare place within metres of a 0.01° line (≤ 1.5 px, see below).
      if (Math.abs(dx) > 0.5 + 1e-9 || Math.abs(dy) > 0.5 + 1e-9) expect(Math.max(Math.abs(dx), Math.abs(dy))).toBeLessThanOrEqual(1.5)
      // Its centre always rounds to the place's own 0.01° point (the curve's key, mask and region).
      const [clat, clon] = nativeCentre(32633, b)
      expect([round2(clat), round2(clon)]).toEqual([round2(lat), round2(lon)])
    }
  })
  it('steps one pixel over rather than let the centre cross a 0.01° line from the place', () => {
    // 1 m south of 52.525 (the line between 52.52 and 52.53): the nearest corner may lie north of it.
    const lat = 52.525 - 1 / 111_200
    const b = nativeBox(G33, lat, 13.405, 1000)
    expect(round2(nativeCentre(32633, b)[0])).toBe(52.52)
    const [, y] = utmForward(32633, lat, 13.405)
    expect(Math.abs(y - (b[1] + b[3]) / 2)).toBeLessThanOrEqual(15)
  })
  it('puts Landsat corners 15 m off the 30 m lattice, negative northings and all (Sydney on UTM 56N)', () => {
    const b = nativeBox(GLS, SYDNEY.lat, SYDNEY.lon, 500)
    expect(b.map((v) => ((v % 30) + 30) % 30)).toEqual([15, 15, 15, 15])
    expect(b[3]).toBeLessThan(0)
    expect(b[2] - b[0]).toBe(15_000)
  })
})

describe('native crop URLs and their tone plan', () => {
  it('asks Planetary Computer for the place’s grid: grid CRS in and out, Lanczos only for a scene that needs a warp', () => {
    const url = pcCropUrlAt('sentinel-2-l2a', S2, BERLIN.lat, BERLIN.lon, 5, 1000, 'jpg')
    expect(url).toMatch(/^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/\d+,\d+,\d+,\d+\/1000x1000\.jpg\?collection=sentinel-2-l2a&item=S2A_[^&]+&coord_crs=EPSG:32633&dst_crs=EPSG:32633&assets=B04&assets=B03&assets=B02&asset_as_band=true&expression=[^&]+&rescale=0,100&nodata=0&reproject=lanczos$/)
    expect(cropCrs(url)).toBe(32633)
    // Other sizes of the same box: resampled on the grid with Lanczos (thumbnails; Landsat's exact 2×).
    expect(pcCropUrlAt('sentinel-2-l2a', S2, BERLIN.lat, BERLIN.lon, 5, 112, 'jpg')).toMatch(/\/112x112\.jpg\?.*&reproject=lanczos&resampling=lanczos$/)
    expect(pcCropUrlAt('landsat-c2-l2', LS, SYDNEY.lat, SYDNEY.lon, 7.5, 1000, 'jpg')).toMatch(/\/bbox\/\d+5,-\d+5,\d+5,-\d+5\/1000x1000\.jpg\?collection=landsat-c2-l2&.*&coord_crs=EPSG:32656&dst_crs=EPSG:32656&.*&resampling=lanczos$/)
    // Geographic (the globe's decals; places beyond UTM): the lon/lat recipe, unchanged.
    expect(pcCropUrlAt('sentinel-2-l2a', S2, BERLIN.lat, BERLIN.lon, 5, 1000, 'jpg', true)).toBe(pcCropUrlFor('sentinel-2-l2a', S2, boxAround(BERLIN.lat, BERLIN.lon, 5), 1000, 'jpg'))
    expect(cropCrs(pcCropUrlAt('sentinel-2-l2a', S2, 84.5, 10, 5, 1000, 'jpg'))).toBe(4326)
  })

  it('reads one plan back for the app’s photo and the server’s card: one key, one mask, one measuring square on the grid', () => {
    const EXACT = { lat: 52.5186, lon: 13.4083 }
    const photo = tonePlanForUrl(pcCropUrlAt('sentinel-2-l2a', S2, EXACT.lat, EXACT.lon, 5, 1000, 'jpg'))!
    const card = tonePlanForUrl(pcCropUrlAt('sentinel-2-l2a', S2, 52.52, 13.41, 3.15, 630, 'jpg'))!
    const thumb = tonePlanForUrl(pcCropUrlAt('sentinel-2-l2a', S2, EXACT.lat, EXACT.lon, 5, 112, 'jpg'))!
    for (const p of [photo, card, thumb]) {
      expect(p.crs).toBe(32633)
      expect([p.lat, p.lon]).toEqual([52.52, 13.41])
      expect(p.key).toBe(`sentinel-2-l2a|${S2}|52.52,13.41`)
      expect(p.maskUrl).toBe(maskUrl('sentinel-2-l2a', S2, 52.52, 13.41)) // in lon/lat, whatever the crop's geometry
      expect(p.ref).toEqual(card.box) // the server's card IS the measuring square
    }
    expect(photo.metresPerPx).toBe(10)
    expect(card.metresPerPx).toBe(10)
    expect(canShareCurve(photo)).toBe(true)
    expect(canShareCurve(thumb)).toBe(false)
    // The square sits inside the photo at whole-pixel offsets.
    const [px0, py0, px1, py1] = photo.box
    const [cx0, cy0, cx1, cy1] = card.box
    expect(cx0 > px0 && cy0 > py0 && cx1 < px1 && cy1 < py1).toBe(true)
    expect([(cx0 - px0) % 10, (py1 - cy1) % 10, cx1 - cx0]).toEqual([0, 0, CARD_NATIVE_PX['sentinel-2-l2a'] * 10])
    // The mask is the photo's square around the rounded point, warped to lon/lat by PC (each cell its centre's class).
    expect(photo.maskUrl).toMatch(/\/bbox\/[\d.]+,[\d.]+,[\d.]+,[\d.]+\/64x64\.npy\?collection=sentinel-2-l2a&item=S2A_[^&]+&assets=SCL$/)
    expect(maskKeyForUrl(photo.maskUrl)).toBe(photo.key)
  })

  it('reads Landsat plans on its grid: 15 m photo and card pixels, the card square 315 native pixels', () => {
    const photo = tonePlanForUrl(pcCropUrlAt('landsat-c2-l2', LS, SYDNEY.lat, SYDNEY.lon, 7.5, 1000, 'jpg'))!
    const card = tonePlanForUrl(pcCropUrlAt('landsat-c2-l2', LS, -33.87, 151.21, 4.725, 630, 'jpg'))!
    expect(photo.crs).toBe(32656)
    expect([photo.lat, photo.lon]).toEqual([-33.87, 151.21])
    expect(photo.metresPerPx).toBe(15)
    expect(card.metresPerPx).toBe(15)
    expect(photo.ref).toEqual(card.box)
    expect(card.box[2] - card.box[0]).toBe(CARD_NATIVE_PX['landsat-c2-l2'] * 30)
    expect(photo.maskUrl).toBe(card.maskUrl)
    expect(photo.maskUrl).toContain('&assets=qa_pixel')
    expect(PHOTO_NATIVE_PX['landsat-c2-l2'] * 30).toBe(15_000)
  })

  it('refuses a CRS mix it never builds', () => {
    const url = pcNativeCropUrlFor('sentinel-2-l2a', S2, G33, nativeBox(G33, BERLIN.lat, BERLIN.lon, 1000), 1000, 'jpg')
    expect(tonePlanForUrl(url.replace('dst_crs=EPSG:32633', 'dst_crs=EPSG:4326'))).toBeNull()
    expect(tonePlanForUrl(url.replace(/EPSG:32633/g, 'EPSG:3031'))).toBeNull()
  })
})

describe('where the place and north are in a crop on the place’s grid', () => {
  const cases = [
    { name: 'Berlin', coll: 'sentinel-2-l2a', item: S2, gsd: 10, epsg: 32633, at: BERLIN, half: 5 },
    { name: 'Sydney (south)', coll: 'sentinel-2-l2a', item: S2_SYD, gsd: 10, epsg: 32756, at: SYDNEY, half: 5 },
    { name: 'zone 33 east edge', coll: 'sentinel-2-l2a', item: S2, gsd: 10, epsg: 32633, at: { lat: 59.33, lon: 17.9 }, half: 5 },
    { name: 'Landsat Sydney (56N)', coll: 'landsat-c2-l2', item: LS, gsd: 30, epsg: 32656, at: SYDNEY, half: 7.5 },
  ] as const
  for (const c of cases)
    it(`puts the reticle (the centre) within half a native pixel of the place: ${c.name}`, () => {
      const url = pcCropUrlAt(c.coll, c.item, c.at.lat, c.at.lon, c.half, 1000, 'jpg')
      expect(cropCrs(url)).toBe(c.epsg)
      const p = placeInCrop(url, c.at.lat, c.at.lon)!
      const nativePx = (2 * c.half * 1000) / c.gsd
      expect(Math.abs(p.fx - 0.5) * nativePx).toBeLessThanOrEqual(0.5)
      expect(Math.abs(p.fy - 0.5) * nativePx).toBeLessThanOrEqual(0.5)
      expect(northInCropDeg(url)).toBeCloseTo(gridBearingOfNorthDeg(c.epsg, c.at.lat, c.at.lon), 3)
    })
  it('says north is up for geographic crops and other images', () => {
    expect(northInCropDeg(pcCropUrlFor('sentinel-2-l2a', S2, boxAround(52.52, 13.405, 5), 1000, 'jpg'))).toBe(0)
    expect(northInCropDeg('https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS')).toBe(0)
    expect(northInCropDeg(pcCropUrlAt('sentinel-2-l2a', S2, 59.33, 17.9, 5, 1000, 'jpg'))).toBeCloseTo(-2.49, 1)
  })
})

describe('the lon/lat mask under a crop on the grid', () => {
  it('maps grid metres to lon/lat through a lattice of exact projections, within a metre of the projection', () => {
    const url = maskUrl('sentinel-2-l2a', S2, 59.33, 17.9)
    const mask = maskFromResponse(url, maskNpy(64, 64, () => 4))
    for (const at of [{ lat: 59.33, lon: 17.9 }, { lat: 52.52, lon: 13.405 }, { lat: -33.87, lon: 151.21 }]) {
      const g = placeGrid('sentinel-2-l2a', at.lat, at.lon)!
      const box = nativeBox(g, at.lat, at.lon, 1500) // 15 km: Landsat's photo, the largest crop on a grid
      const map = toMaskCrs({ ...mask, box: boxAround(at.lat, at.lon, 7.5) }, g.epsg, box)!
      const r = rng(7)
      let worst = 0
      for (let i = 0; i < 400; i++) {
        const x = box[0] + r() * (box[2] - box[0])
        const y = box[1] + r() * (box[3] - box[1])
        const [lon, lat] = map(x, y)
        const [ex, ey] = utmForward(g.epsg, lat, lon)
        worst = Math.max(worst, Math.hypot(ex - x, ey - y))
      }
      expect(worst).toBeLessThan(0.5) // metres, against 156 m mask cells
    }
  })

  it('reads a lon/lat mask across the antimeridian from either side', () => {
    const url = maskUrl('sentinel-2-l2a', 'S2B_MSIL2A_20261105T221609_R029_T01KBU_20261105T235959', -16.5, 179.99)
    const mask = maskFromResponse(url, maskNpy(64, 64, (x) => (x < 32 ? 9 : 4)))
    expect(mask.box[2]).toBeGreaterThan(180) // the box runs past it
    const [x] = maskPoint(mask, -16.5, -179.975) // ≈ 3.7 km east of 179.99° E, given as a west longitude
    expect(x).toBeCloseTo(180.025, 6)
    expect(mask.raw[maskCellAtLatLon(mask, -16.5, -179.975)]).toBe(4)
    expect(mask.raw[maskCellAtLatLon(mask, -16.5, 179.95)]).toBe(9)
  })

  it('tones a crop on the grid with its lon/lat mask: the cloud it leaves out is the same ground', () => {
    // Ground truth: cloud west of 13.387° E, a dark city ramp east of it. The lon/lat mask marks cloud west of 13.39° E
    // (its 156 m cells, as SCL's, are coarser than the picture: the cloud line runs through them).
    const url = maskUrl('sentinel-2-l2a', S2, 52.52, 13.41)
    const mb = (JSON.parse(`[${/\/bbox\/([^/]+)\//.exec(url)![1]}]`) as number[]) as Box
    const mask = maskFromResponse(url, maskNpy(64, 64, (x) => (mb[0] + ((x + 0.5) / 64) * (mb[2] - mb[0]) < 13.39 ? 9 : 4)))
    expect(mask.crs).toBe(4326)
    // The app's photo on the grid, 100 px for the test (100 m pixels).
    const plan = tonePlanForUrl(pcCropUrlAt('sentinel-2-l2a', S2, 52.52, 13.41, 5, 1000, 'jpg'))!
    const W = 100
    const px = new Uint8ClampedArray(W * W * 4)
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        const gx = plan.box[0] + ((x + 0.5) / W) * (plan.box[2] - plan.box[0])
        const gy = plan.box[3] - ((y + 0.5) / W) * (plan.box[3] - plan.box[1])
        const lon = utmInverse(32633, gx, gy)[1]
        const v = lon < 13.387 ? 0.8 : 0.02 + 0.2 * (x / W)
        const i = (y * W + x) * 4
        px[i] = px[i + 1] = px[i + 2] = Math.round(Math.sqrt(v) * 255)
        px[i + 3] = 255
      }
    const unmasked = measureTone(px, W, W, plan.box, plan.ref, null, undefined, 1, plan.crs)
    const masked = measureTone(px, W, W, plan.box, plan.ref, mask, undefined, 1, plan.crs)
    expect(unmasked.white).toBeGreaterThan(0.7) // the cloud sets it
    expect(masked.white).toBeLessThan(0.3) // the ground does: the lon/lat mask was found through lat/lon
    // Reading the mask as if it were on the crop's grid would look the cloud up in the wrong place entirely.
    const confused = measureTone(px, W, W, plan.box, plan.ref, { ...mask, crs: 32633 }, undefined, 1, plan.crs)
    expect(confused.white).toBeGreaterThan(0.7)
  })
})
