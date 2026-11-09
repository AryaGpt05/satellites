import { describe, expect, it } from 'vitest'
import { parseStats, RANGES } from './api'
import { mockStats } from './fixture'
import { fmtBucket, fmtPct, niceMax } from './format'

describe('admin_stats parsing', () => {
  it('accepts the fixture for every range', () => {
    for (const r of RANGES) {
      const s = parseStats(JSON.parse(JSON.stringify(mockStats(r, Date.UTC(2026, 10, 9, 12)))))
      expect(s?.range).toBe(r)
      expect(s!.series.length).toBeGreaterThan(20)
      expect(s!.top['search.label'][0][0]).toBe('Waterloo, Ontario, Canada')
    }
  })
  it('rejects junk and fills gaps', () => {
    expect(parseStats(null)).toBeNull()
    expect(parseStats({ range: 'forever' })).toBeNull()
    const s = parseStats({ range: '7d', totals: { search: 'x', session: 3 }, top: { 'a.b': [['x', 1], 'junk', [2, 3]] }, results: null })!
    expect(s.totals).toEqual({ search: 0, session: 3 })
    expect(s.top['a.b']).toEqual([['x', 1]])
    expect(s.results).toEqual({ n: 0, p50Ms: null, p90Ms: null, partial: 0, archiveFailed: 0 })
    expect(s.series).toEqual([])
  })
})

describe('formats', () => {
  it('nice axis maxima', () => {
    expect([1, 3, 7, 12, 99, 101, 240].map(niceMax)).toEqual([1, 5, 10, 20, 100, 200, 250])
  })
  it('percentages and buckets', () => {
    expect(fmtPct(0.0612)).toBe('6.1%')
    expect(fmtPct(0.5)).toBe('50%')
    expect(fmtPct(null)).toBe('—')
    expect(fmtBucket(Date.UTC(2026, 10, 8, 14), 'hour')).toBe('NOV 08 14:00')
    expect(fmtBucket(Date.UTC(2026, 10, 8, 0), 'hour', true)).toBe('NOV 08')
    expect(fmtBucket(Date.UTC(2026, 10, 8), 'day')).toBe('NOV 08')
  })
})
