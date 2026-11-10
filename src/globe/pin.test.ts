import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { latLonToWorld } from '@/lib/geo'
import { CLICK_MAX_MS, CLICK_SLOP_PX, HOLD_SLOP_PX, holdStill, isPinClick, pickSurface, raySphere, roundPin, type PressStart } from './pin'

function cameraLookingAt(lat: number, lon: number, dist = 4) {
  const cam = new PerspectiveCamera(30, 1.5, 0.01, 400)
  cam.position.copy(latLonToWorld(lat, lon, dist))
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld()
  cam.updateProjectionMatrix()
  return cam
}

describe('pickSurface', () => {
  it('finds the point under the screen centre', () => {
    for (const [lat, lon] of [
      [43.47, -80.54],
      [-33.87, 151.21],
      [0, 179.9],
      [71, -8],
    ]) {
      const hit = pickSurface(0, 0, cameraLookingAt(lat, lon))
      expect(hit).not.toBeNull()
      expect(hit!.lat).toBeCloseTo(lat, 6)
      expect(hit!.lon).toBeCloseTo(lon, 6)
    }
  })

  it('round-trips a projected surface point, off centre', () => {
    const cam = cameraLookingAt(20, 10)
    const p = latLonToWorld(28, 18, 1).project(cam)
    const hit = pickSurface(p.x, p.y, cam)
    expect(hit!.lat).toBeCloseTo(28, 5)
    expect(hit!.lon).toBeCloseTo(18, 5)
  })

  it('misses in space beside the planet', () => {
    expect(pickSurface(0.95, 0.95, cameraLookingAt(0, 0, 20))).toBeNull()
  })

  it('honours an off-axis lens shift (the camera director shifts the projection)', () => {
    const cam = cameraLookingAt(10, 20)
    cam.setViewOffset(1500, 1000, 300, 0, 1500, 1000)
    cam.updateProjectionMatrix()
    const p = latLonToWorld(12, 23, 1).project(cam)
    const hit = pickSurface(p.x, p.y, cam)
    expect(hit!.lat).toBeCloseTo(12, 5)
    expect(hit!.lon).toBeCloseTo(23, 5)
  })
})

describe('raySphere', () => {
  it('returns the near intersection', () => {
    const hit = raySphere(new Vector3(0, 0, 5), new Vector3(0, 0, -1), 1)
    expect(hit!.z).toBeCloseTo(1)
  })
  it('misses a ray pointing away', () => {
    expect(raySphere(new Vector3(0, 0, 5), new Vector3(0, 0, 1), 1)).toBeNull()
  })
})

describe('gestures', () => {
  const press = (o: Partial<PressStart> = {}): PressStart => ({ x: 100, y: 100, at: 0, pointerType: 'mouse', button: 0, modifier: false, ...o })
  it('a still, quick left click drops a pin', () => {
    expect(isPinClick(press(), 100 + CLICK_SLOP_PX, 100, CLICK_MAX_MS)).toBe(true)
  })
  it('a drag, a slow press, a right button, a modifier or a touch does not', () => {
    expect(isPinClick(press(), 100 + CLICK_SLOP_PX + 1, 100, 10)).toBe(false)
    expect(isPinClick(press(), 100, 100, CLICK_MAX_MS + 1)).toBe(false)
    expect(isPinClick(press({ button: 2 }), 100, 100, 10)).toBe(false)
    expect(isPinClick(press({ modifier: true }), 100, 100, 10)).toBe(false)
    expect(isPinClick(press({ pointerType: 'touch' }), 100, 100, 10)).toBe(false)
  })
  it('a hold survives a finger wobble, not a drag', () => {
    const p = press({ pointerType: 'touch' })
    expect(holdStill(p, 100 + HOLD_SLOP_PX, 100)).toBe(true)
    expect(holdStill(p, 100 + HOLD_SLOP_PX + 1, 100)).toBe(false)
  })
  it('rounds pins to 5 decimals', () => {
    expect(roundPin(43.4723456)).toBe(43.47235)
  })
})
