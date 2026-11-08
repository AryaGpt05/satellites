import { describe, expect, it } from 'vitest'
import { fmtAge, fmtGmst, fmtLatFixed, fmtLonFixed, fmtObjects, fmtSource, fmtStampZ, fmtSun, isStale } from './readouts'

describe('corner readout formatters', () => {
  it('pads latitude and longitude to fixed widths', () => {
    expect(fmtLatFixed(-6.24)).toBe('06.2°S')
    expect(fmtLatFixed(23.44)).toBe('23.4°N')
    expect(fmtLatFixed(0)).toBe('00.0°N')
    expect(fmtLonFixed(118.2)).toBe('118.2°E')
    expect(fmtLonFixed(-8)).toBe('008.0°W')
    expect(fmtLonFixed(190)).toBe('170.0°W')
    expect(fmtLonFixed(-179.97)).toBe('180.0°E')
    expect(fmtSun({ lat: -16.21, lon: 63.04 })).toBe('SUN 16.2°S 063.0°E')
  })

  it('keeps every sub-solar readout the same width', () => {
    const widths = new Set<number>()
    for (let lat = -23.4; lat <= 23.4; lat += 3.7) for (let lon = -179.9; lon <= 180; lon += 13.3) widths.add(fmtSun({ lat, lon }).length)
    expect([...widths]).toEqual([18])
  })

  it('formats GMST as sidereal HH:MM:SS', () => {
    // J2000.0 epoch: GMST ≈ 18h 41m 50.5s
    expect(fmtGmst(Date.UTC(2000, 0, 1, 12, 0, 0))).toBe('18:41:50')
    expect(fmtGmst(Date.UTC(2026, 10, 8, 4, 0, 0))).toMatch(/^\d\d:\d\d:\d\d$/)
  })

  it('formats catalog stamps and ages', () => {
    expect(fmtStampZ('2026-11-08T03:34:02.063Z')).toBe('2026-11-08 03:34Z')
    expect(fmtStampZ('nope')).toBe('—')
    const t = Date.UTC(2026, 10, 8, 3, 34)
    expect(fmtAge(t, t + 30_000)).toBe('<1 MIN')
    expect(fmtAge(t, t + 75_000)).toBe('1 MIN')
    expect(fmtAge(t, t + 42 * 60_000)).toBe('42 MIN')
    expect(fmtAge(t, t + 5 * 3_600_000)).toBe('5 H')
    expect(fmtAge(t, t + 3 * 86_400_000)).toBe('3 D')
    expect(fmtAge(t, t - 1000)).toBe('<1 MIN')
  })

  it('flags element sets older than two days', () => {
    const iso = '2026-11-08T03:34:02Z'
    const t = Date.parse(iso)
    expect(isStale(iso, t + 47 * 3_600_000)).toBe(false)
    expect(isStale(iso, t + 49 * 3_600_000)).toBe(true)
    expect(isStale('garbage', t)).toBe(false)
  })

  it('labels the catalog', () => {
    expect(fmtObjects(16893)).toBe('16,893 OBJECTS')
    expect(fmtSource('CelesTrak GP')).toBe('CELESTRAK GP')
    expect(fmtSource('CelesTrak GP (GROUP=active)')).toBe('CELESTRAK GP')
    expect(fmtSource('')).toBe('CATALOG')
  })
})
