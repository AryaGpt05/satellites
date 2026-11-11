import { describe, expect, it } from 'vitest'
import { gibsWmsUrl } from './endpoints'
import { greyInfrared, isEnhancedInfraredUrl } from './infrared'

const px = (...rgb: number[][]) => new Uint8ClampedArray(rgb.flatMap(([r, g, b]) => [r, g, b, 255]))
const grey = (...rgb: number[][]) => {
  const a = px(...rgb)
  greyInfrared(a)
  return Array.from({ length: rgb.length }, (_, i) => a[i * 4])
}

describe('enhanced infrared, in grey', () => {
  it('leaves the grey ramp alone, JPEG noise included', () => {
    expect(grey([5, 5, 5], [120, 120, 120], [204, 204, 204])).toEqual([5, 120, 204])
    const [noisy] = grey([118, 124, 121])
    expect(Math.abs(noisy - 122)).toBeLessThanOrEqual(2)
  })

  it('writes one value to all three channels and keeps alpha', () => {
    const a = px([0, 255, 0])
    a[3] = 77
    greyInfrared(a)
    expect(a[0]).toBe(a[1])
    expect(a[1]).toBe(a[2])
    expect(a[3]).toBe(77)
  })

  it('puts the rainbow above the ramp in its own order: cyan, blue, green, yellow, red, dark red', () => {
    // Palette entries read off a lossless GIBS render (Himawari Clean Infrared, 2026-11-10T16:00Z).
    const v = grey([0, 255, 255], [0, 128, 185], [0, 0, 115], [0, 128, 58], [0, 255, 0], [255, 255, 0], [255, 128, 0], [255, 0, 0], [102, 0, 0], [51, 0, 0])
    expect(v[0]).toBe(205)
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThan(v[i - 1])
    expect(v[v.length - 1]).toBeLessThanOrEqual(255)
    expect(v[4]).toBe(225) // green: two fifths of the way
  })

  it('reads a dark stop smeared by JPEG chroma as cold, not as a dark ring', () => {
    expect(grey([10, 10, 60])[0]).toBeGreaterThan(204)
  })
})

describe('which images are redrawn', () => {
  const place = { lat: 35.68, lon: 139.65 }
  const at = '2026-11-10T16:00:00Z'
  it('only GIBS Clean Infrared layers', () => {
    expect(isEnhancedInfraredUrl(gibsWmsUrl('Himawari_AHI_Band13_Clean_Infrared', at, place, { halfSizeKm: 400, px: 176 }))).toBe(true)
    expect(isEnhancedInfraredUrl(gibsWmsUrl('Himawari_AHI_Band3_Red_Visible_1km', at, place, { halfSizeKm: 400, px: 176 }))).toBe(false)
    expect(isEnhancedInfraredUrl(gibsWmsUrl('GOES-East_ABI_GeoColor', at, place, { halfSizeKm: 400, px: 176 }))).toBe(false)
    expect(isEnhancedInfraredUrl('https://example.test/?LAYERS=Himawari_AHI_Band13_Clean_Infrared')).toBe(false)
  })
})
