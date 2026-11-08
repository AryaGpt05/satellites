import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PixelFetch } from './pixels'

/** A stand-in for pixels.worker.ts: records requests; the test answers them. */
class FakeWorker {
  static last: FakeWorker | undefined
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Partial<ErrorEvent>) => void) | null = null
  onmessageerror: (() => void) | null = null
  sent: { type: string; id: number; url?: string }[] = []
  terminated = false
  constructor() {
    FakeWorker.last = this
  }
  postMessage(m: { type: string; id: number; url?: string }) {
    this.sent.push(m)
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }
  terminate() {
    this.terminated = true
  }
}

const pixels = (): PixelFetch => ({ status: 200, contentType: 'image/png', pixels: { data: new Uint8ClampedArray(16), width: 2, height: 2 } })

async function load() {
  vi.resetModules()
  return import('./pixelsClient')
}

describe('fetchPixels (pixels worker client)', () => {
  beforeEach(() => {
    FakeWorker.last = undefined
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('OffscreenCanvas', class {})
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('unused')))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends the request to the worker and resolves with its answer', async () => {
    const { fetchPixels } = await load()
    const p = fetchPixels('https://example.test/a.png')
    const w = FakeWorker.last!
    expect(w.sent).toEqual([{ type: 'fetch', id: 1, url: 'https://example.test/a.png' }])
    const r = pixels()
    w.reply({ type: 'ok', id: 1, r })
    await expect(p).resolves.toBe(r)
  })

  it('rejects network failures as TypeError (retryable, like fetch)', async () => {
    const { fetchPixels } = await load()
    const p = fetchPixels('https://example.test/b.png')
    FakeWorker.last!.reply({ type: 'error', id: 1, name: 'TypeError', message: 'Failed to fetch' })
    await expect(p).rejects.toBeInstanceOf(TypeError)
  })

  it('aborts: rejects at once and tells the worker', async () => {
    const { fetchPixels } = await load()
    const ctl = new AbortController()
    const p = fetchPixels('https://example.test/c.png', ctl.signal)
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.last!.sent.at(-1)).toEqual({ type: 'abort', id: 1 })
    // A late answer for the aborted request is ignored.
    FakeWorker.last!.reply({ type: 'ok', id: 1, r: pixels() })
  })

  it('a worker that fails to start hands its requests to this thread', async () => {
    const fetched: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetched.push(url)
        return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })
      }),
    )
    const { fetchPixels } = await load()
    const p = fetchPixels('https://example.test/d.png')
    const w = FakeWorker.last!
    w.onerror?.({ preventDefault: () => undefined })
    await expect(p).resolves.toMatchObject({ status: 404, body: 'nope' })
    expect(w.terminated).toBe(true)
    // Later requests stay on this thread.
    await expect(fetchPixels('https://example.test/e.png')).resolves.toMatchObject({ status: 404 })
    expect(fetched).toEqual(['https://example.test/d.png', 'https://example.test/e.png'])
  })

  it('without OffscreenCanvas it never starts a worker', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 200, headers: { 'content-type': 'text/xml' } })))
    const { fetchPixels } = await load()
    await expect(fetchPixels('https://example.test/f')).resolves.toEqual({ status: 200, contentType: 'text/xml' })
    expect(FakeWorker.last).toBeUndefined()
  })
})
