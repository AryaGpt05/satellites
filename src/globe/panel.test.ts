import { describe, expect, it } from 'vitest'
import { Vector4 } from 'three'
import { northInCropDeg, pcCropUrlAt } from '../../api/_lib/toneRender'
import { utmInverse } from '../../api/_lib/utm'
import { inPanelAxes, panelHalfKm, panelTurn, patchUv } from './panel'

/** The decal's patch coordinate of a lat/lon, centred (shaders/chunks.ts patchCoord − 0.5): east, north. */
function patchPoint(b: Vector4, lat: number, lon: number): [number, number] {
  const u = 0.5 + lon / 360
  const v = 0.5 + lat / 180
  let dx = u - b.x
  dx -= Math.floor(dx + 0.5)
  return [dx / b.z, (v - b.y) / b.w]
}

/** The corners of a photo on the place's grid, as lat/lon, from its URL's box (grid metres). */
function photoCorners(url: string, epsg: number): [number, number][] {
  const [w, s, e, n] = /\/bbox\/([^/]+)\//.exec(url)![1].split(',').map(Number)
  return [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
  ].map(([x, y]) => utmInverse(epsg, x, y))
}

describe('the panel photo’s square on the globe', () => {
  // Berlin (+1.3°), Bergen (+3.2°: Norway’s wide zone 32), Ny-Ålesund (+2.8°), Svalbard’s east edge (−5.9°).
  const places = [
    { name: 'Berlin', lat: 52.517, lon: 13.3889, epsg: 32633 },
    { name: 'Bergen', lat: 60.39, lon: 5.32, epsg: 32632 },
    { name: 'Ny-Ålesund', lat: 78.92, lon: 11.93, epsg: 32633 },
    { name: 'Kong Karls Land', lat: 78.9, lon: 20.9, epsg: 32633 },
  ]
  for (const p of places)
    it(`outlines exactly the grid-cut photo, turned by the convergence (${p.name})`, () => {
      const url = pcCropUrlAt('sentinel-2-l2a', 'S2A_MSIL2A_20261105T101121_R022_T33UUU_20261105T164009', p.lat, p.lon, panelHalfKm('sentinel-2-l2a'), 1000, 'jpg')
      expect(url).toContain(`coord_crs=EPSG:${p.epsg}`)
      const decalHalfKm = 40 // acquisition.ts decalSpecFor
      const b = patchUv(p.lat, p.lon, decalHalfKm, new Vector4())
      const half = panelHalfKm('sentinel-2-l2a') / (2 * decalHalfKm) // Imagery.tsx uPanelHalf
      const north = northInCropDeg(url)
      const turn = panelTurn(north)
      const signs: [number, number][] = [
        [-1, 1],
        [1, 1],
        [1, -1],
        [-1, -1],
      ]
      let turned = 0
      let unturned = 0
      photoCorners(url, p.epsg).forEach(([lat, lon], i) => {
        const pm = patchPoint(b, lat, lon)
        const [x, y] = inPanelAxes(pm, turn)
        const [ux, uy] = inPanelAxes(pm, [1, 0])
        turned = Math.max(turned, Math.abs(x - signs[i][0] * half), Math.abs(y - signs[i][1] * half))
        unturned = Math.max(unturned, Math.abs(ux - signs[i][0] * half), Math.abs(uy - signs[i][1] * half))
      })
      // Each corner of the drawn square is the photo's corner, to < 0.5 % of its side (the patch's spherical km
      // against the grid's ellipsoidal metres); drawn axis-aligned it would be off by the turn itself.
      expect(turned / (2 * half)).toBeLessThan(0.005)
      if (Math.abs(north) > 1) expect(unturned).toBeGreaterThan(3 * turned)
    })
})
