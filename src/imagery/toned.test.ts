import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maskNpy } from '../../api/_lib/npyTesting'
import { boxAround, maskUrl, pcCropUrlAt, pcCropUrlFor, tonePlanForUrl, toneCrop } from '../../api/_lib/tone'
import { fetchMaskHere, fetchTonedHere, sharedCurve } from './pixels'

const S2 = 'S2C_MSIL2A_20261101T161421_R140_T17TNJ_20261102T164803'
const WATERLOO = { lat: 43.4723, lon: -80.5449 }

/** A decoded "image": the canvas stand-ins below hand these pixels to the tone step and keep what it writes. */
let decoded: Uint8ClampedArray
let written: Uint8ClampedArray | null
let size = 0

function pixels(n: number, seed: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(n * n * 4)
  for (let i = 0; i < n * n; i++) {
    const v = 20 + ((i * 37 + seed) % 120)
    px.set([v + 6, v, Math.max(0, v - 10), 255], i * 4)
  }
  return px
}

beforeEach(() => {
  written = null
  vi.stubGlobal('createImageBitmap', async () => ({ width: size, height: size, close() {} }))
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          drawImage() {},
          getImageData: () => ({ data: decoded.slice(), width: size, height: size }),
          putImageData: (img: { data: Uint8ClampedArray }) => {
            written = img.data
          },
        }
      }
      async convertToBlob(o: { type: string }) {
        return new Blob([(written ?? new Uint8Array()) as unknown as BlobPart], { type: o.type })
      }
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('.npy?')
        ? new Response(maskNpy(64, 64, () => 4))
        : new Response(new Uint8Array(2048), { headers: { 'content-type': 'image/jpeg' } }),
    ),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchTonedHere', () => {
  it('tones a crop with the shared step, and reuses the card’s curve for the sharper render', async () => {
    const card = pcCropUrlFor('sentinel-2-l2a', S2, boxAround(WATERLOO.lat, WATERLOO.lon, 5), 64, 'jpg')
    const plan = tonePlanForUrl(card)!
    // 64 px over 10 km is too coarse to share; measure the same thing at card scale through a 1024-px URL name.
    const cardUrl = card.replace('/64x64.jpg', '/1024x1024.jpg')
    size = 64
    decoded = pixels(64, 1)
    const r = await fetchTonedHere(cardUrl)
    expect(r.contentType).toBe('image/jpeg')
    expect(r.blob?.type).toBe('image/jpeg')
    const curve = sharedCurve(plan.key)
    expect(curve).toBeDefined()
    // Same pixels as the shared step run directly (what the server runs).
    const want = decoded.slice()
    toneCrop(want, 64, 64, tonePlanForUrl(cardUrl)!, null, curve)
    expect([...written!]).toEqual([...want])

    // The lightbox's sharper render of the same capture and place: the card's curve, not a new one.
    decoded = pixels(64, 99)
    const hi = cardUrl.replace('/1024x1024.jpg', '/2048x2048.png')
    await fetchTonedHere(hi, undefined, 'png')
    const want2 = decoded.slice()
    toneCrop(want2, 64, 64, tonePlanForUrl(hi)!, null, curve)
    expect([...written!]).toEqual([...want2])
    expect(sharedCurve(plan.key)).toEqual(curve)
  })

  it('does not let a thumbnail set the capture’s curve, and passes other images through', async () => {
    const thumb = pcCropUrlFor('sentinel-2-l2a', 'S2A_MSIL2A_20261027T162651_R040_T17TNJ_20261027T231305', boxAround(WATERLOO.lat, WATERLOO.lon, 5), 112, 'jpg')
    size = 32
    decoded = pixels(32, 3)
    await fetchTonedHere(thumb)
    expect(sharedCurve(tonePlanForUrl(thumb)!.key)).toBeUndefined()
    written = null
    const r = await fetchTonedHere('https://example.org/x.jpg')
    expect(r.blob?.size).toBe(2048)
    expect(written).toBeNull()
  })

  it('never asks for a thumbnail’s mask of its own (CT-7)', async () => {
    const thumb = pcCropUrlFor('sentinel-2-l2a', 'S2B_MSIL2A_20261027T161359_R140_T17TNJ_20261027T200624', boxAround(WATERLOO.lat, WATERLOO.lon, 5), 112, 'jpg')
    size = 32
    decoded = pixels(32, 5)
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    f.mockClear()
    await fetchTonedHere(thumb)
    expect(f.mock.calls.map((c) => String(c[0]))).toEqual([thumb])
  })

  it('tones a photo on the grid, then a geographic globe decal of the same capture with that photo’s curve and mask, one mask request', async () => {
    const id = 'S2A_MSIL2A_20261103T162651_R040_T17TNJ_20261103T231305'
    const photo = pcCropUrlAt('sentinel-2-l2a', id, WATERLOO.lat, WATERLOO.lon, 5, 1000, 'jpg')
    expect(photo).toContain('coord_crs=EPSG:32617')
    const decal = pcCropUrlFor('sentinel-2-l2a', id, boxAround(WATERLOO.lat, WATERLOO.lon, 40), 1024, 'jpg')
    expect(tonePlanForUrl(decal)!.key).toBe(tonePlanForUrl(photo)!.key)
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    f.mockClear()
    size = 64
    decoded = pixels(64, 11)
    await fetchTonedHere(photo)
    const curve = sharedCurve(tonePlanForUrl(photo)!.key)
    expect(curve).toBeDefined()
    decoded = pixels(64, 12)
    await fetchTonedHere(decal)
    const want = decoded.slice()
    toneCrop(want, 64, 64, tonePlanForUrl(decal)!, null, curve)
    expect([...written!]).toEqual([...want])
    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.includes('.npy?'))).toEqual([tonePlanForUrl(photo)!.maskUrl])
    expect(urls).toEqual([tonePlanForUrl(photo)!.maskUrl, photo, decal].sort((a, b) => urls.indexOf(a) - urls.indexOf(b)))
  })

  it('waits for its capture’s mask, already in flight, for a geographic decal toned before any photo (no request of its own)', async () => {
    const id = 'S2A_MSIL2A_20261031T162651_R040_T17TNJ_20261031T231305'
    const native = maskUrl('sentinel-2-l2a', id, WATERLOO.lat, WATERLOO.lon)
    let resolve!: (r: Response) => void
    const f = vi.fn((url: string) =>
      url.includes('.npy?') ? new Promise<Response>((r) => (resolve = r)) : Promise.resolve(new Response(new Uint8Array(2048), { headers: { 'content-type': 'image/jpeg' } })),
    )
    vi.stubGlobal('fetch', f)
    // The spot check asks for the mask first (in flight).
    const spot = fetchMaskHere(native)
    const decal = pcCropUrlFor('sentinel-2-l2a', id, boxAround(WATERLOO.lat, WATERLOO.lon, 40), 1024, 'jpg')
    size = 64
    decoded = pixels(64, 13)
    const toned = fetchTonedHere(decal)
    await new Promise((r) => setTimeout(r, 0))
    resolve(new Response(maskNpy(64, 64, () => 4)))
    await spot
    await toned
    // The decal waited on the spot check's mask (the same lon/lat URL as the photo's) and asked for nothing else.
    expect(f.mock.calls.map((c) => String(c[0]))).toEqual([native, decal])
    expect(written).not.toBeNull()
  })

  it('does not share a curve measured without the mask: the next size measures again (P2-3)', async () => {
    const id = 'S2B_MSIL2A_20261030T162419_R040_T17TNJ_20261030T200303'
    const card = pcCropUrlFor('sentinel-2-l2a', id, boxAround(WATERLOO.lat, WATERLOO.lon, 5), 1024, 'jpg')
    const plan = tonePlanForUrl(card)!
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('.npy?')
          ? new Response('upstream request timeout', { status: 504 })
          : new Response(new Uint8Array(2048), { headers: { 'content-type': 'image/jpeg' } }),
      ),
    )
    size = 64
    decoded = pixels(64, 7)
    await fetchTonedHere(card)
    expect(sharedCurve(plan.key)).toBeUndefined()
  })
})

describe('the lightbox’s sharper layer (a magnified view)', () => {
  it('takes the curve its photo was shown with, even one measured before the mask came: only sharpness changes', async () => {
    const id = 'S2A_MSIL2A_20261031T162419_R040_T17TNJ_20261031T200303'
    const photo = pcCropUrlAt('sentinel-2-l2a', id, WATERLOO.lat, WATERLOO.lon, 5, 1000, 'jpg')
    const hi = pcCropUrlAt('sentinel-2-l2a', id, WATERLOO.lat, WATERLOO.lon, 5, 2000, 'jpg')
    let maskCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('.npy?')
          ? ++maskCalls === 1
            ? new Response('upstream request timeout', { status: 504 })
            : new Response(maskNpy(64, 64, (x) => (x < 32 ? 9 : 4))) // the mask, once it comes, says half is cloud
          : new Response(new Uint8Array(2048), { headers: { 'content-type': 'image/jpeg' } }),
      ),
    )
    size = 64
    decoded = pixels(64, 11)
    const shownWith = toneCrop(decoded.slice(), 64, 64, tonePlanForUrl(photo)!, null)
    await fetchTonedHere(photo)
    expect(sharedCurve(tonePlanForUrl(photo)!.key)).toBeUndefined() // toned without its mask: not shared
    decoded = pixels(64, 12)
    const want = decoded.slice()
    toneCrop(want, 64, 64, tonePlanForUrl(hi)!, null, shownWith)
    await fetchTonedHere(hi)
    expect([...written!]).toEqual([...want])
    expect(sharedCurve(tonePlanForUrl(photo)!.key)).toBeUndefined() // nor did the layer measure one of its own
  })
})

describe('fetchMaskHere', () => {
  it('asks again after a transient HTTP error instead of keeping it for the session (CT-1)', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (++calls === 1 ? new Response('upstream request timeout', { status: 504 }) : new Response(maskNpy(64, 64, () => 4)))),
    )
    const url = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/-80.606803,43.427334,-80.473197,43.517266/64x64.npy?collection=sentinel-2-l2a&item=S2X_CT1&assets=SCL'
    const first = await fetchMaskHere(url)
    expect(first.status).toBe(504)
    expect(first.mask).toBeUndefined()
    const second = await fetchMaskHere(url)
    expect(second.status).toBe(200)
    expect(second.mask).toBeDefined()
    expect(await fetchMaskHere(url)).toBe(second) // a good answer is kept: no third request
    expect(calls).toBe(2)
    // A 404 (off the scene) is the archive's final word: kept.
    let calls404 = 0
    vi.stubGlobal('fetch', vi.fn(async () => (calls404++, new Response('outside', { status: 404 }))))
    const url404 = url.replace('S2X_CT1', 'S2X_CT1_404')
    await fetchMaskHere(url404)
    await fetchMaskHere(url404)
    expect(calls404).toBe(1)
  })
})
