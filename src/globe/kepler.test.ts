/**
 * The satellite vertex shader must reproduce the engine's reference propagation (keplerJ2World) exactly.
 * Rather than re-typing the math, this test transpiles the GLSL source of KEPLER_J2 to JavaScript and runs
 * it on real catalog rows, once in float64 (formula identity) and once with float32 rounding at every step
 * (what a highp GPU does), and compares both with the reference.
 */
import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { buildElementBuffer, ELEMENT_STRIDE, keplerJ2World, type ElementBuffer } from '@/engine'
import { loadTestCatalog } from '@/engine/testing'
import { EARTH_RADIUS_KM, gmst } from '@/lib/geo'
import { KEPLER_J2 } from './shaders/chunks'

type V4 = { x: number; y: number; z: number; w: number }
type ShaderFn = (el0: V4, el1: V4, el2: V4, uTime: number, uGmst: { x: number; y: number }, f: (x: number) => number) => number[]

/**
 * GLSL (the subset this one function uses) → JS. `f` rounds every assignment and every built-in call
 * (Math.fround for float32, identity for float64).
 */
function transpile(src: string): ShaderFn {
  const body = src.slice(src.indexOf('{', src.indexOf('keplerJ2World(')) + 1, src.lastIndexOf('}'))
  const js = body
    .replace(/highp\s+float\s+(\w+)\s*=\s*([^;]+);/g, 'let $1 = f($2);')
    .replace(/for\s*\(int k = 0; k < 4; k\+\+\)\s*E\s*-=\s*([^;]+);/, 'for (let k = 0; k < 4; k++) E = f(E - ($1));')
    .replace(/return vec3\(([^)]+)\);/, 'return [$1];')
  if (/highp|vec3|int /.test(js)) throw new Error(`untranslated GLSL:\n${js}`)
  const prelude = `
    const TWO_PI = ${2 * Math.PI};
    const sin = (x) => f(Math.sin(x)), cos = (x) => f(Math.cos(x)), sqrt = (x) => f(Math.sqrt(x)), max = (a, b) => f(Math.max(a, b));
    const mod = (x, y) => f(x - y * Math.floor(x / y));`
  return new Function('el0', 'el1', 'el2', 'uTime', 'uGmst', 'f', `${prelude}\n${js}`) as ShaderFn
}

function loadBuffer(): ElementBuffer {
  return buildElementBuffer(loadTestCatalog())
}

const v4 = (d: Float32Array, o: number): V4 => ({ x: d[o], y: d[o + 1], z: d[o + 2], w: d[o + 3] })

describe('KEPLER_J2 shader vs the engine reference (keplerJ2World)', () => {
  const shader = transpile(KEPLER_J2)
  const buf = loadBuffer()
  const pick = [25544, 42063, 43013, 27424, 41866, 48274] // ISS, Sentinel-2B, NOAA-20, Aqua, GOES-16, CSS
  const indexOf = new Map<number, number>()
  for (let i = 0; i < buf.count; i++) indexOf.set(buf.norad[i], i)

  const run = (index: number, ms: number, f: (x: number) => number) => {
    const o = index * ELEMENT_STRIDE
    const g = gmst(ms)
    // The CPU uploads uTime and (cos, sin)(gmst) as float32 uniforms.
    const uTime = Math.fround((ms - buf.refEpochMs) / 1000)
    return shader(v4(buf.data, o), v4(buf.data, o + 4), v4(buf.data, o + 8), uTime, { x: Math.fround(Math.cos(g)), y: Math.fround(Math.sin(g)) }, f)
  }

  it('is the same formula (float64)', () => {
    const ref = new Vector3()
    let worst = 0
    for (const norad of pick) {
      const i = indexOf.get(norad)
      if (i === undefined) continue
      for (const h of [-72, -6, 0, 3, 50, 160]) {
        const ms = buf.refEpochMs + h * 3_600_000
        keplerJ2World(buf, i, ms, ref)
        const [x, y, z] = run(i, ms, (v) => v)
        worst = Math.max(worst, Math.hypot(x - ref.x, y - ref.y, z - ref.z) * EARTH_RADIUS_KM)
      }
    }
    // Only the float32 uTime / gmst uniforms differ from the float64 reference (measured: ~1 m).
    expect(worst).toBeLessThan(0.05)
  })

  it('stays within ~2 km of the reference with float32 arithmetic across the ±7 day window (whole catalog sample)', () => {
    const ref = new Vector3()
    let worst = 0
    let n = 0
    for (let i = 0; i < buf.count; i += 37) {
      for (const h of [-168, -24, 0, 24, 168]) {
        const ms = buf.refEpochMs + h * 3_600_000
        keplerJ2World(buf, i, ms, ref)
        const [x, y, z] = run(i, ms, Math.fround)
        const errKm = (Math.hypot(x - ref.x, y - ref.y, z - ref.z) * EARTH_RADIUS_KM) / Math.max(1, ref.length())
        worst = Math.max(worst, errKm)
        n++
      }
    }
    expect(n).toBeGreaterThan(2000)
    // Measured ~0.9 km. At globe scale 1 px ≈ 15–30 km. Errors are normalised by orbit radius (Earth radii),
    // so GEO objects are judged by their angular error, which is what shows on screen.
    expect(worst).toBeLessThan(2)
  })
})
