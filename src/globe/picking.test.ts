import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { nearestWithin, occludedByEarth, projectPoints } from './picking'

describe('occludedByEarth', () => {
  const cam = new Vector3(0, 0, 5)
  it('hides a satellite behind the planet', () => {
    expect(occludedByEarth(cam, new Vector3(0, 0, -1.1))).toBe(true)
  })
  it('shows a satellite in front of the planet', () => {
    expect(occludedByEarth(cam, new Vector3(0, 0, 1.1))).toBe(false)
  })
  it('shows a satellite beside the limb', () => {
    expect(occludedByEarth(cam, new Vector3(1.2, 0, -0.5))).toBe(false)
  })
  it('hides a satellite just behind the limb', () => {
    expect(occludedByEarth(cam, new Vector3(0.9, 0, -0.8))).toBe(true)
  })
})

describe('screen picking', () => {
  const camera = new PerspectiveCamera(30, 1, 0.01, 100)
  camera.position.set(0, 0, 5)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()

  it('projects to CSS pixels and marks occluded points', () => {
    const pos = new Float32Array([0, 0, 1.2, 0, 0, -1.2])
    const out = new Float32Array(4)
    projectPoints(pos, 2, camera, 800, 800, out)
    expect(out[0]).toBeCloseTo(400, 6)
    expect(out[1]).toBeCloseTo(400, 6)
    expect(Number.isNaN(out[2])).toBe(true)
  })

  it('returns the nearest point within the radius, ignoring hidden ones', () => {
    const screen = new Float32Array([100, 100, NaN, NaN, 108, 100, 300, 300])
    expect(nearestWithin(screen, 4, 106, 101, 12)).toBe(2)
    expect(nearestWithin(screen, 4, 200, 200, 12)).toBe(-1)
  })
})
