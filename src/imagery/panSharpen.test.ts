import { describe, expect, it } from 'vitest'
import { panSharpen } from './panSharpen'

function rgbaOf(w: number, h: number, f: (x: number, y: number) => [number, number, number]) {
  const a = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y)
      const o = (y * w + x) * 4
      a[o] = r
      a[o + 1] = g
      a[o + 2] = b
      a[o + 3] = 255
    }
  return a
}
const grey = (w: number, h: number, f: (x: number, y: number) => number) => rgbaOf(w, h, (x, y) => [f(x, y), f(x, y), f(x, y)])

describe('panSharpen', () => {
  it('leaves the photo as it is where the pan band is flat', () => {
    const photo = rgbaOf(16, 16, () => [120, 100, 80])
    const before = photo.slice()
    const covered = panSharpen(photo, grey(16, 16, () => 140), 16, 16)
    expect(covered).toBe(1)
    for (let i = 0; i < photo.length; i++) expect(Math.abs(photo[i] - before[i])).toBeLessThanOrEqual(1)
  })

  it('puts the 15 m detail into a flat 30 m pixel, keeping its hue', () => {
    // A bright 15 m stripe (x = 8) inside a flat colour: the pan says so, the photo gains it.
    const photo = rgbaOf(16, 16, () => [120, 100, 80])
    panSharpen(photo, grey(16, 16, (x) => (x === 8 ? 200 : 140)), 16, 16)
    const at = (x: number) => photo.slice((8 * 16 + x) * 4, (8 * 16 + x) * 4 + 3)
    const [r, g, b] = at(8)
    expect(r).toBeGreaterThan(130)
    // Hue kept: the channels keep their order and roughly their ratios.
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
    expect(r / b).toBeCloseTo(120 / 80, 0)
    // Its neighbours give a little light back (the 30 m mean is kept).
    expect(at(7)[0]).toBeLessThanOrEqual(120)
  })

  it('keeps the mean brightness of an area', () => {
    const photo = grey(32, 32, () => 128)
    panSharpen(photo, grey(32, 32, (x, y) => ((x + y) % 2 ? 170 : 110)), 32, 32)
    let sum = 0
    for (let i = 0; i < photo.length; i += 4) sum += Math.pow(photo[i] / 255, 2.2)
    expect(sum / (32 * 32)).toBeCloseTo(Math.pow(128 / 255, 2.2), 1)
  })

  it('leaves no-data pixels alone (in either image) and reports the cover', () => {
    const photo = rgbaOf(8, 8, (x) => (x === 0 ? [0, 0, 0] : [90, 90, 90]))
    const pan = grey(8, 8, (x, y) => (y < 4 ? 0 : x === 5 ? 220 : 120))
    const covered = panSharpen(photo, pan, 8, 8)
    expect(covered).toBe(0.5)
    expect(Array.from(photo.slice(0, 3))).toEqual([0, 0, 0])
    expect(photo[(1 * 8 + 5) * 4]).toBe(90) // no pan there
    expect(photo[(6 * 8 + 5) * 4]).toBeGreaterThan(90)
  })

  it('clamps the gain (a glint or a cloud edge never blows out)', () => {
    const photo = grey(8, 8, () => 60)
    panSharpen(photo, grey(8, 8, (x, y) => (x === 4 && y === 4 ? 255 : 20)), 8, 8)
    expect(photo[(4 * 8 + 4) * 4]).toBeLessThan(90)
  })
})
