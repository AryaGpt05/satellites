import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pass } from '@/types'

const createShare = vi.fn()
vi.mock('@/lib/backend', () => ({ createShare: (...a: unknown[]) => createShare(...a) }))

const { createShareSafe, peekShare } = await import('./backend')

const pass = (id: string) => ({ id, norad: 60989, tClosest: 1, verdict: 'imaged', track: [] }) as unknown as Pass
const input = (id: string) => ({ placeLabel: 'Waterloo', lat: 43.47, lon: -80.54, pass: pass(id) })

describe('share adapter', () => {
  beforeEach(() => {
    createShare.mockReset()
  })

  it('writes nothing until asked, then one row per pass for the session', async () => {
    createShare.mockResolvedValue({ id: 'abcd1234', url: '' })
    expect(peekShare(input('p1'))).toBeUndefined()
    expect(createShare).not.toHaveBeenCalled()
    expect(await createShareSafe(input('p1'))).toBe('abcd1234')
    expect(await createShareSafe(input('p1'))).toBe('abcd1234')
    expect(await peekShare(input('p1'))).toBe('abcd1234')
    expect(createShare).toHaveBeenCalledTimes(1)
  })

  it('does not cache failures, so a later press can still succeed', async () => {
    createShare.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'efgh5678', url: '' })
    expect(await createShareSafe(input('p2'))).toBeNull()
    expect(peekShare(input('p2'))).toBeUndefined()
    expect(await createShareSafe(input('p2'))).toBe('efgh5678')
  })

  it('gives up after the timeout (the sheet falls back to the deep link)', async () => {
    createShare.mockImplementation(() => new Promise(() => undefined)) // never answers
    expect(await createShareSafe(input('p3'), 20)).toBeNull()
  })
})
