import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROFILES } from '@/engine/profiles'
import type { GeoFrameSource } from '@/types'

vi.mock('./gibs', async (orig) => ({ ...(await orig<typeof import('./gibs')>()), latestGibsFrame: vi.fn() }))
vi.mock('./image', async (orig) => ({ ...(await orig<typeof import('./image')>()), preloadImage: vi.fn(async (url: string) => ({ dataset: { nodata: url === 'u-rim' ? '0.85' : '0.00' } })) }))
vi.mock('./eumetsat', async (orig) => ({ ...(await orig<typeof import('./eumetsat')>()), latestEumetsatFrame: vi.fn() }))

import { latestEumetsatFrame } from './eumetsat'
import { GEO_FRAMES, isEumetsatSource, latestGeoFrame } from './geoFrames'
import { HIMAWARI_INFRARED, latestGibsFrame } from './gibs'

const TOKYO = { lat: 35.6762, lon: 139.6503 }
const DELHI = { lat: 28.6139, lon: 77.209 }
const OPTS = { halfSizeKm: 400, px: 176 }
const gibs = vi.mocked(latestGibsFrame)
const eumetsat = vi.mocked(latestEumetsatFrame)

afterEach(() => vi.clearAllMocks())

describe('geostationary frame sources', () => {
  it('every profile that names a source is an operational geostationary imager, one satellite per source', () => {
    const named = PROFILES.filter((p) => p.frames)
    expect(named.map((p) => p.displayName).sort()).toEqual(['GOES-18', 'GOES-19', 'Himawari-9', 'Meteosat-12', 'Meteosat-9'])
    for (const p of named) {
      expect(p.category).toBe('weather-geo')
      expect(p.operational).toBe(true)
      expect(GEO_FRAMES[p.frames as GeoFrameSource]).toBeDefined()
    }
    expect(new Set(named.map((p) => p.frames)).size).toBe(named.length)
  })

  it('a daylight layer is always backed by one that works in the dark, and infrared comes last', () => {
    for (const spec of Object.values(GEO_FRAMES)) {
      const last = spec.layers[spec.layers.length - 1]
      expect(last.via === 'gibs' ? last.layer.visibleOnly : last.layer.minSunDeg).toBeFalsy()
      expect(spec.layers.findIndex((l) => l.band === 'infrared')).toBeOneOf([-1, spec.layers.length - 1])
    }
  })

  it('knows whose frames carry the EUMETSAT attribution', () => {
    expect(isEumetsatSource('meteosat-0deg')).toBe(true)
    expect(isEumetsatSource('meteosat-iodc')).toBe(true)
    expect(isEumetsatSource('goes-east')).toBe(false)
    expect(isEumetsatSource('himawari')).toBe(false)
  })
})

describe('the newest frame of a source', () => {
  it("is the first layer's when it has one, labelled with that layer's band and pixel", async () => {
    gibs.mockResolvedValueOnce({ url: 'u-visible', time: 5 })
    await expect(latestGeoFrame('himawari', TOKYO, OPTS)).resolves.toEqual({ url: 'u-visible', time: 5, band: 'visible', gridKm: 1, empty: 0 })
    expect(gibs).toHaveBeenCalledTimes(1)
  })

  it('falls back to infrared when the daylight layer has nothing (night)', async () => {
    gibs.mockResolvedValueOnce(null).mockResolvedValueOnce({ url: 'u-ir', time: 7 })
    await expect(latestGeoFrame('himawari', TOKYO, OPTS)).resolves.toEqual({ url: 'u-ir', time: 7, band: 'infrared', gridKm: 2, empty: 0 })
    expect(gibs.mock.calls[1][0]).toBe(HIMAWARI_INFRARED)
    // The daylight layer is only asked for its newest few frames; the last layer searches as far as it likes.
    expect(gibs.mock.calls[0][3]).toMatchObject({ maxSteps: 3 })
    expect(gibs.mock.calls[1][3]?.maxSteps).toBeUndefined()

    eumetsat.mockResolvedValueOnce(null).mockResolvedValueOnce({ url: 'e-ir', time: 9 })
    await expect(latestGeoFrame('meteosat-iodc', DELHI, OPTS)).resolves.toEqual({ url: 'e-ir', time: 9, band: 'infrared', gridKm: 5, empty: 0 })
    expect(eumetsat.mock.calls.map((c) => c[0].layer)).toEqual(['msg_iodc:rgb_naturalenhncd', 'msg_iodc:ir108'])
  })

  it('says how much of the frame is empty, as the loader measured it', async () => {
    eumetsat.mockResolvedValueOnce({ url: 'u-rim', time: 3 })
    await expect(latestGeoFrame('meteosat-0deg', DELHI, OPTS)).resolves.toMatchObject({ url: 'u-rim', empty: 0.85 })
  })

  it('is null when no layer has a frame, and passes an abort through', async () => {
    eumetsat.mockResolvedValue(null)
    await expect(latestGeoFrame('meteosat-0deg', DELHI, OPTS)).resolves.toBeNull()
    eumetsat.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
    await expect(latestGeoFrame('meteosat-0deg', DELHI, OPTS)).rejects.toThrow('Aborted')
  })
})
