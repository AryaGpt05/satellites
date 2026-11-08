import { describe, expect, it } from 'vitest'
import type { Share } from '@/lib/backend'
import { shareCropUrl } from './cropUrl'

const SHARE: Share = {
  id: 'ab3d5f7h',
  placeLabel: 'Waterloo',
  lat: 43.47,
  lon: -80.54,
  verdict: 'imaged',
  capture: { collection: 'sentinel-2-l2a', itemId: 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803', provider: 'planetary-computer' },
}

describe('shareCropUrl', () => {
  it('crops the shared item around the rounded point, framed like the pass view', () => {
    const url = shareCropUrl(SHARE, 640)!
    expect(url).toMatch(/^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/[-\d.,]+\/640x640\.jpg\?collection=sentinel-2-l2a&item=S2C_MSIL2A_20261101/)
    // A 10 km square: ±5 km ≈ ±0.045° of latitude around 43.47.
    const [, s, , n] = /bbox\/([^/]+)\//.exec(url)![1].split(',').map(Number)
    expect(n - s).toBeCloseTo(0.0899, 3)
    expect((n + s) / 2).toBeCloseTo(43.47, 4)
  })
  it('builds GIBS frames and refuses what a URL cannot crop', () => {
    expect(shareCropUrl({ ...SHARE, capture: { collection: 'gibs-modis-aqua', itemId: 'MODIS_Aqua_CorrectedReflectance_TrueColor@2026-11-02' } }, 512)).toContain('TIME=2026-11-02')
    expect(shareCropUrl({ ...SHARE, capture: { collection: 'sentinel-2-l2a', itemId: 'S2C_T17TNJ_20261101T161421_L2A', provider: 'earth-search' } }, 512)).toBeUndefined()
    expect(shareCropUrl({ ...SHARE, capture: undefined }, 512)).toBeUndefined()
  })
})
