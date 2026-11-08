import { describe, expect, it } from 'vitest'
import type { Pass } from '@/types'
import { passLinkOpts, pickPreselect, readUrlTarget } from './links'
import { raceTimeout } from './timing'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-08T18:00:00Z')

describe('raceTimeout (R2K1)', () => {
  it('lets an already-settled promise win a 0 ms (or negative) race', async () => {
    await expect(raceTimeout(Promise.resolve(1), 0)).resolves.toBe(1)
    await expect(raceTimeout(Promise.resolve('share'), -1500)).resolves.toBe('share')
  })
  it('resolves null for a pending promise, and for a rejection', async () => {
    await expect(raceTimeout(new Promise(() => undefined), 0)).resolves.toBeNull()
    await expect(raceTimeout(Promise.reject(new Error('x')), 50)).resolves.toBeNull()
  })
  it('waits up to ms for a slower promise', async () => {
    const slow = new Promise<number>((r) => setTimeout(() => r(7), 20))
    await expect(raceTimeout(slow, 200)).resolves.toBe(7)
  })
})

const pass = (id: string, norad: number, tClosest: number) => ({ id, norad, tClosest }) as Pass

describe('readUrlTarget', () => {
  it('reads share links, plain deep links and the landing', () => {
    expect(readUrlTarget('?s=abcd2345', NOW)).toEqual({ kind: 'share', id: 'abcd2345' })
    expect(readUrlTarget('', NOW)).toBeNull()
    expect(readUrlTarget('?q=200,1&n=x', NOW)).toBeNull()
    expect(readUrlTarget('?sandbox=globe&q=43,-80', NOW)).toBeNull()
    expect(readUrlTarget('?q=43.4723,-80.5449&n=Waterloo&p=60989-29892501', NOW)).toEqual({
      kind: 'q',
      place: { label: 'Waterloo', lat: 43.4723, lon: -80.5449, source: 'url' },
      opts: { selectPassId: '60989-29892501' },
    })
  })

  it("opens an old fallback share link on its pass: the window centred on t (R2K5)", () => {
    const t = NOW - 10 * DAY
    const target = readUrlTarget(`?q=43.47,-80.54&n=Waterloo&p=x&sat=Sentinel-2C&norad=60989&verdict=imaged&t=${t}`, NOW)
    expect(target).toMatchObject({ kind: 'q', place: { lat: 43.47, lon: -80.54, label: 'Waterloo' } })
    const opts = target?.kind === 'q' ? target.opts : {}
    expect(opts).toEqual({ now: t + 3.5 * DAY, selectNorad: 60989, selectNear: t })
    // The window [now − 7 d, now] contains t, centred on it.
    const end = opts.now!
    expect(end - 7 * DAY < t && t < end).toBe(true)
    // …and the pass it opens is that satellite's pass nearest t, whatever ?p= said.
    const passes = [pass('60989-a', 60989, t - 5 * DAY), pass('60989-b', 60989, t + 60_000), pass('42063-c', 42063, t), pass('60989-d', 60989, t + 2 * DAY)]
    expect(pickPreselect({ passes, windowEnd: end }, opts)).toBe('60989-b')
  })

  it('keeps a recent fallback link on the default window', () => {
    const t = NOW - 2 * DAY
    const target = readUrlTarget(`?q=43.47,-80.54&n=Waterloo&p=x&norad=60989&t=${t}`, NOW)
    expect(target?.kind === 'q' && target.opts).toEqual({ now: NOW, selectNorad: 60989, selectNear: t })
  })

  it('falls back to the pass id when t or norad is missing or invalid', () => {
    for (const bad of ['&norad=60989', `&t=${NOW - DAY}`, '&norad=60989&t=-5', '&norad=60989&t=abc', '&norad=0&t=1793549661025', '&norad=1.5&t=1793549661025', '&norad=60989&t=', '&norad=x&t=1793549661025']) {
      const target = readUrlTarget(`?q=43.47,-80.54&n=Waterloo&p=60989-29892501${bad}`, NOW)
      expect(target?.kind === 'q' && target.opts, bad).toEqual({ selectPassId: '60989-29892501' })
    }
  })
})

describe('passLinkOpts / pickPreselect', () => {
  it('centres the window only for passes older than six days', () => {
    expect(passLinkOpts(NOW - 6.5 * DAY, 1, NOW).now).toBe(NOW - 3 * DAY)
    expect(passLinkOpts(NOW - 5 * DAY, 1, NOW).now).toBe(NOW)
  })
  it('prefers the named pass, then the norad nearest the time, else nothing', () => {
    const passes = [pass('a', 1, 100), pass('b', 1, 300), pass('c', 2, 200)]
    expect(pickPreselect({ passes, windowEnd: 1000 }, { selectPassId: 'c', selectNorad: 1 })).toBe('c')
    expect(pickPreselect({ passes, windowEnd: 1000 }, { selectPassId: 'zz', selectNorad: 1, selectNear: 260 })).toBe('b')
    expect(pickPreselect({ passes, windowEnd: 1000 }, { selectNorad: 1 })).toBe('b')
    expect(pickPreselect({ passes, windowEnd: 1000 }, { selectNorad: 9 })).toBeUndefined()
    expect(pickPreselect({ passes, windowEnd: 1000 }, {})).toBeUndefined()
  })
})
