import { describe, expect, it } from 'vitest'
import type { Share } from '@/lib/backend'
import { shareCropUrl } from './cropUrl'
import { pcCropUrl } from '@/imagery'
import { utmInverse } from '../../../api/_lib/utm'

const SHARE: Share = {
  id: 'ab3d5f7h',
  placeLabel: 'Waterloo',
  lat: 43.47,
  lon: -80.54,
  verdict: 'imaged',
  capture: { collection: 'sentinel-2-l2a', itemId: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803', provider: 'planetary-computer' },
}

describe('shareCropUrl', () => {
  it('crops the shared item around the rounded point, framed like the pass view: the pass view’s own URL', () => {
    const url = shareCropUrl(SHARE)!
    // On the place's grid (UTM 17N): 1000 of its 10 m pixels, a 10 km square (T17TNJ's own pixels, copied 1:1).
    expect(url).toMatch(/^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/[\d,]+\/1000x1000\.jpg\?collection=sentinel-2-l2a&item=S2C_MSIL2A_20261101[^&]+&coord_crs=EPSG:32617&dst_crs=EPSG:32617&/)
    const [w, s, e, n] = /bbox\/([^/]+)\//.exec(url)![1].split(',').map(Number)
    expect([e - w, n - s]).toEqual([10_000, 10_000])
    const [lat, lon] = utmInverse(32617, (w + e) / 2, (s + n) / 2)
    expect(Math.abs(lat - 43.47) * 111_000).toBeLessThan(10)
    expect(Math.abs(lon + 80.54) * 80_600).toBeLessThan(10)
    // The recipient's report builds the same URL for the same scene (the grid follows from the place).
    expect(url).toBe(pcCropUrl('sentinel-2-l2a', SHARE.capture!.itemId, { lat: 43.47, lon: -80.54 }, { halfSizeKm: 5, px: 1000 }).replace('.png?', '.jpg?'))
    // An explicit size still works (any px on the same box).
    expect(shareCropUrl(SHARE, 640)).toMatch(/\/640x640\.jpg\?.*&resampling=lanczos$/)
  })
  it('crops a Landsat scene on the same grid at once: no lookup, the zone follows from the place', () => {
    const ls: Share = { ...SHARE, capture: { collection: 'landsat-c2-l2', itemId: 'LC09_L2SP_018030_20261031_02_T1', provider: 'planetary-computer' } }
    expect(shareCropUrl(ls)).toMatch(/\/bbox\/\d+5,\d+5,\d+5,\d+5\/1000x1000\.jpg\?collection=landsat-c2-l2&item=LC09[^&]+&coord_crs=EPSG:32617&/)
  })
  it('builds GIBS frames and refuses what a URL cannot crop', () => {
    expect(shareCropUrl({ ...SHARE, capture: { collection: 'gibs-modis-aqua', itemId: 'MODIS_Aqua_CorrectedReflectance_TrueColor@2026-11-02' } }, 512)).toContain('TIME=2026-11-02')
    expect(shareCropUrl({ ...SHARE, capture: { collection: 'sentinel-2-l2a', itemId: 'S2C_T17TNJ_20261101T161421_L2A', provider: 'earth-search' } }, 512)).toBeUndefined()
    expect(shareCropUrl({ ...SHARE, capture: undefined }, 512)).toBeUndefined()
  })
})
