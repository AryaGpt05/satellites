/**
 * The 1200×630 share card, in the Instrument style (docs/DESIGN.md):
 * near-black ink, warm bone type, one sodium-orange signal, 1px hairlines, Martian Mono numerics,
 * condensed Instrument Sans display, one Instrument Serif italic phrase.
 *
 *   ┌──────────── 630 ────────────┬──────────────── 570 ────────────────┐
 *   │                             │ OVERFLIGHT                NORAD 60989│
 *   │   real satellite crop       │ ──────────────────────────────────── │
 *   │   (or the pass geometry)    │ ◆ PHOTOGRAPHED   2026-11-01 16:14 UTC│
 *   │            ⊕                │                                      │
 *   │                             │ Sentinel-2C photographed  Waterloo.  │
 *   │                             │ ──────────────────────────────────── │
 *   │ SENTINEL-2 L2A    ├─ 1 KM ─┤│ ALT 786 KM │ OFF-NADIR 0.9° │ CLOUD │
 *   │                             │ 43.47°N 80.54°W        overflight.app│
 *   └─────────────────────────────┴──────────────────────────────────────┘
 */
import type { CSSProperties, ReactElement } from 'react'
import { FONT } from './fonts.js'
import { box, h, type Child } from './h.js'
import type { CropPlan } from './imagery.js'
import { fmtUtc, headlineParts, momentOf, satLabel, type ShareRecord, type Verdict } from './share.js'

export const CARD_W = 1200
export const CARD_H = 630
export const PLATE = 630

// Mirrors src/styles/tokens.css (satori has no CSS variables).
export const C = {
  ink0: '#07080A',
  ink1: '#0C0E11',
  ink2: '#14171C',
  bone: '#ECE8E0',
  bone2: 'rgba(236,232,224,0.64)',
  bone3: 'rgba(236,232,224,0.40)',
  bone4: 'rgba(236,232,224,0.18)',
  line: 'rgba(236,232,224,0.10)',
  lineStrong: 'rgba(236,232,224,0.22)',
  signal: '#FF6A1A',
  signal2: 'rgba(255,106,26,0.22)',
} as const

const PAD_X = 52
const PANEL_W = CARD_W - PLATE

// ── Type primitives ─────────────────────────────────────────────────────────────────────────

/** Mono caps label: tracking +0.08em, as `.label` in primitives.module.css. */
function mono(text: string, size: number, color: string, style: CSSProperties = {}): ReactElement {
  return h(
    'div',
    {
      style: {
        display: 'flex',
        fontFamily: FONT.mono,
        fontSize: size,
        letterSpacing: size * 0.08,
        textTransform: 'uppercase',
        color,
        lineHeight: 1.3,
        whiteSpace: 'nowrap',
        ...style,
      },
    },
    text,
  )
}

const hairline = (style: CSSProperties = {}) => box({ height: 1, width: '100%', background: C.line, ...style })

// ── Glyphs (1px-stroke marks, as src/ui/system/Glyph.tsx) ───────────────────────────────────

function verdictGlyph(v: Verdict, size = 14): ReactElement {
  const s = size
  const m = s / 2
  const stroke = { fill: 'none', stroke: v === 'imaged' || v === 'likely' ? C.signal : C.bone, strokeWidth: 1.25 }
  let mark: ReactElement
  if (v === 'imaged') mark = h('path', { d: `M${m} 1 L${s - 1} ${m} L${m} ${s - 1} L1 ${m} Z`, fill: C.signal })
  else if (v === 'likely') mark = h('path', { d: `M${m} 1.5 L${s - 1.5} ${m} L${m} ${s - 1.5} L1.5 ${m} Z`, ...stroke })
  else if (v === 'could') mark = h('rect', { x: 2, y: 2, width: s - 4, height: s - 4, ...stroke })
  else mark = h('path', { d: `M${m} 1.5 V${s - 1.5} M1.5 ${m} H${s - 1.5}`, ...stroke })
  return h('svg', { width: s, height: s, viewBox: `0 0 ${s} ${s}` }, mark)
}

const VERDICT_TAG: Record<Verdict, string> = {
  imaged: 'Photographed',
  likely: 'In swath',
  could: 'Within view',
  overhead: 'Overhead',
}

// ── Plates (the left square) ────────────────────────────────────────────────────────────────

/** The place reticle: thin ring, four ticks, centre dot (DESIGN §6), in signal. */
function reticle(cx: number, cy: number, r = 26): ReactElement[] {
  const t0 = r + 9
  const t1 = r + 25
  const sw = 2
  return [
    h('circle', { cx, cy, r, fill: 'none', stroke: C.signal, strokeWidth: sw }),
    h('path', {
      d: `M${cx} ${cy - t0} V${cy - t1} M${cx} ${cy + t0} V${cy + t1} M${cx - t0} ${cy} H${cx - t1} M${cx + t0} ${cy} H${cx + t1}`,
      stroke: C.signal,
      strokeWidth: sw,
    }),
    h('circle', { cx, cy, r: 3, fill: C.signal }),
  ]
}

/** 8px-scale L-shaped corner ticks inset into a square. */
function cornerTicks(size: number, inset: number, len: number, color: string): ReactElement {
  const a = inset
  const b = size - inset
  const d = [
    `M${a} ${a + len} V${a} H${a + len}`,
    `M${b - len} ${a} H${b} V${a + len}`,
    `M${a} ${b - len} V${b} H${a + len}`,
    `M${b - len} ${b} H${b} V${b - len}`,
  ].join(' ')
  return h('path', { d, fill: 'none', stroke: color, strokeWidth: 1.5 })
}

/** Flat ink chip for text over imagery (no blur, no shadow: DESIGN §1). */
function chip(children: Child | Child[], style: CSSProperties = {}): ReactElement {
  return box(
    { position: 'absolute', alignItems: 'center', gap: 10, padding: '7px 10px 6px', background: 'rgba(7,8,10,0.78)', border: `1px solid ${C.lineStrong}`, ...style },
    children,
  )
}

function fmtLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`
}

/** "Nice" round length ≤ max for a scale bar: 1, 2, 5 × 10ⁿ. */
export function niceLength(max: number): number {
  const p = 10 ** Math.floor(Math.log10(max))
  for (const m of [5, 2, 1]) if (m * p <= max) return m * p
  return p
}

function fmtKm(km: number): string {
  return km >= 1 ? `${km} KM` : `${Math.round(km * 1000)} M`
}

/** Scale bar sized to a round ground distance: ├── 1 KM ──┤ */
function scaleBar(metresPerPx: number, maxPx: number): ReactElement {
  const km = niceLength((maxPx * metresPerPx) / 1000)
  const px = Math.round((km * 1000) / metresPerPx)
  return chip(
    [
      box({ width: px, height: 9, borderLeft: `1.5px solid ${C.bone}`, borderRight: `1.5px solid ${C.bone}`, alignItems: 'center' }, box({ height: 1.5, width: '100%', background: C.bone })),
      mono(fmtKm(km), 13, C.bone),
    ],
    { right: 24, bottom: 24 },
  )
}

/** The real image, with reticle, corner ticks, source caption and scale bar. */
function imagePlate(share: ShareRecord, dataUri: string, plan: CropPlan): ReactElement {
  const c = PLATE / 2
  return box(
    { position: 'relative', width: PLATE, height: PLATE, background: C.ink1, overflow: 'hidden' },
    h('img', { src: dataUri, width: PLATE, height: PLATE, style: { position: 'absolute', left: 0, top: 0, width: PLATE, height: PLATE } }),
    h(
      'svg',
      { width: PLATE, height: PLATE, viewBox: `0 0 ${PLATE} ${PLATE}`, style: { position: 'absolute', left: 0, top: 0 } },
      cornerTicks(PLATE, 22, 16, 'rgba(236,232,224,0.85)'),
      ...reticle(c, c),
    ),
    chip(mono(fmtLatLon(share.lat, share.lon), 13, C.bone), { left: c + 44, top: c - 64 }),
    chip([mono(plan.source, 13, C.bone), mono(`${plan.metresPerPx} M/PX`, 13, C.bone3)], { left: 24, bottom: 24 }),
    scaleBar(plan.metresPerPx, 150),
  )
}

/**
 * No image to show (commercial, crewed, not yet archived, or the archive was slow): draw the
 * pass itself, to scale. The place is the reticle at the centre; the ground track passes at the
 * real closest-approach distance and azimuth, in the real direction of travel. North is up.
 */
function geometryPlate(share: ShareRecord, note: string): ReactElement {
  const S = PLATE
  const c = S / 2
  const p = share.pass
  const dist = p.groundDistanceKm
  const halfKm = niceLength(Math.max(30, (dist ?? 0) * 1.7) * 1.25) // keep the track well inside the frame
  const kmToPx = c / halfKm
  const els: ReactElement[] = []

  // Grid: hairlines every 1/12 of the plate, centre axes a touch stronger.
  const step = S / 12
  let grid = ''
  for (let i = 1; i < 12; i++) grid += `M${i * step} 0 V${S} M0 ${i * step} H${S} `
  els.push(h('path', { d: grid, stroke: 'rgba(236,232,224,0.05)', strokeWidth: 1 }))
  els.push(h('path', { d: `M${c} 0 V${S} M0 ${c} H${S}`, stroke: 'rgba(236,232,224,0.09)', strokeWidth: 1 }))
  // Range rings at ½ and 1 × the scale.
  els.push(h('circle', { cx: c, cy: c, r: c / 2, fill: 'none', stroke: 'rgba(236,232,224,0.08)', strokeWidth: 1 }))

  const hdg = p.headingDeg
  // Absolutely-positioned HTML overlays (labels) computed alongside the SVG.
  const overlays: ReactElement[] = []
  if (hdg !== undefined) {
    const rad = Math.PI / 180
    const az = p.azimuthDeg ?? (hdg + 90) % 360
    const g = (dist ?? 0) * kmToPx
    const px = c + g * Math.sin(az * rad)
    const py = c - g * Math.cos(az * rad)
    const dx = Math.sin(hdg * rad)
    const dy = -Math.cos(hdg * rad)
    const nx = -dy
    const ny = dx
    const L = S * 1.5
    const x0 = px - dx * L
    const y0 = py - dy * L
    els.push(
      h(
        'defs',
        null,
        h(
          'linearGradient',
          { id: 'trail', gradientUnits: 'userSpaceOnUse', x1: px - dx * S * 0.7, y1: py - dy * S * 0.7, x2: px, y2: py },
          h('stop', { offset: '0', stopColor: C.bone, stopOpacity: 0 }),
          h('stop', { offset: '1', stopColor: C.bone, stopOpacity: 0.95 }),
        ),
      ),
    )
    // Trail behind the satellite (alpha fading along it, as on the globe), path ahead dashed and dim.
    els.push(h('path', { d: `M${x0} ${y0} L${px} ${py}`, stroke: 'url(#trail)', strokeWidth: 1.5 }))
    els.push(h('path', { d: `M${px + dx * 34} ${py + dy * 34} L${px + dx * L} ${py + dy * L}`, stroke: 'rgba(236,232,224,0.28)', strokeWidth: 1.25, strokeDasharray: '2 6' }))
    // Direction chevron ahead of the satellite.
    const tx = px + dx * 26
    const ty = py + dy * 26
    els.push(
      h('path', {
        d: `M${tx - dx * 8 + nx * 6} ${ty - dy * 8 + ny * 6} L${tx} ${ty} L${tx - dx * 8 - nx * 6} ${ty - dy * 8 - ny * 6}`,
        fill: 'none',
        stroke: C.bone,
        strokeWidth: 1.5,
      }),
    )
    // Closest-approach perpendicular, labelled at its midpoint.
    if (g > 60) {
      els.push(h('path', { d: `M${c} ${c} L${px} ${py}`, stroke: 'rgba(236,232,224,0.55)', strokeWidth: 1, strokeDasharray: '3 4' }))
      const mx = (c + px) / 2
      const my = (c + py) / 2
      const side = dx * (px - c) + dy * (py - c) >= 0 ? 1 : -1 // keep the label off the track
      const lx = mx - dx * 16 * side
      const ly = my - dy * 16 * side
      overlays.push(chip(mono(`${Math.round(dist ?? 0)} KM`, 13, C.bone), lx >= c ? { left: lx, top: ly - 14 } : { right: S - lx, top: ly - 14 }))
    }
    // The satellite at closest approach, and its callout (leader line + hairline box).
    els.push(h('circle', { cx: px, cy: py, r: 6, fill: C.ink1, stroke: C.bone, strokeWidth: 1.5 }))
    const alt = p.altitudeKm !== undefined ? `${Math.round(p.altitudeKm)} KM` : null
    const name = satLabel(share).toUpperCase()
    // Mono 13px with +0.08em tracking ≈ 9.2 px per glyph, plus chip padding and gap.
    const calloutW = (name.length + (alt ? alt.length : 0)) * 9.2 + 34
    // Prefer the side away from the place; flip (mirroring the anchor) when the box won't fit.
    // The box sits above or below the satellite, away from the closest-approach line.
    const away = px >= c ? 1 : -1
    const fits = (sd: number) => (sd > 0 ? S - 16 - (px + 24 + 12) : px - 24 - 12 - 16) >= calloutW
    const side = fits(away) ? away : -away
    const ax = px + side * 24
    const ay = Math.max(76, Math.min(S - 136, py + (py >= c ? 30 : -30)))
    els.push(h('path', { d: `M${px + (ax - px) * 0.3} ${py + (ay - py) * 0.3} L${ax} ${ay} H${ax + side * 12}`, fill: 'none', stroke: C.bone3, strokeWidth: 1 }))
    const callout = [mono(name, 13, C.bone), alt ? mono(alt, 13, C.bone3) : null]
    overlays.push(chip(callout, side > 0 ? { left: ax + 12, top: ay - 15 } : { right: S - ax + 12, top: ay - 15 }))
  }

  els.push(...reticle(c, c, 18))
  els.push(cornerTicks(S, 22, 16, C.bone3))

  return box(
    { position: 'relative', width: S, height: S, background: C.ink1, overflow: 'hidden' },
    h('svg', { width: S, height: S, viewBox: `0 0 ${S} ${S}`, style: { position: 'absolute', left: 0, top: 0 } }, ...els),
    chip([mono('Pass geometry', 13, C.bone2), mono('North up', 13, C.bone3)], { left: 24, top: 24 }),
    ...overlays,
    chip(mono(note, 13, C.bone2), { left: 24, bottom: 24 }),
    chip(
      [
        box({ width: Math.round(c / 2), height: 9, borderLeft: `1.5px solid ${C.bone}`, borderRight: `1.5px solid ${C.bone}`, alignItems: 'center' }, box({ height: 1.5, width: '100%', background: C.bone })),
        mono(fmtKm(halfKm / 2), 13, C.bone),
      ],
      { right: 24, bottom: 24 },
    ),
  )
}

// ── Orthographic globe (default card plate) ─────────────────────────────────────────────────

interface View {
  lat0: number
  lon0: number
  cx: number
  cy: number
  R: number
}

/** Orthographic projection of lat/lon at radius r (Earth radii) → screen + whether it faces us. */
function project(v: View, lat: number, lon: number, r = 1): { x: number; y: number; visible: boolean } {
  const φ = lat * (Math.PI / 180)
  const λ = (lon - v.lon0) * (Math.PI / 180)
  const φ0 = v.lat0 * (Math.PI / 180)
  const depth = Math.cos(φ) * Math.cos(φ0) * Math.cos(λ) + Math.sin(φ) * Math.sin(φ0)
  const xe = Math.cos(φ) * Math.sin(λ)
  const yn = Math.cos(φ0) * Math.sin(φ) - Math.sin(φ0) * Math.cos(φ) * Math.cos(λ)
  // Front hemisphere only. (Orbit arcs that wrap the limb behind the globe read as a second,
  // mis-registered outline at this scale, so they are cut at the limb like the surface.)
  const visible = depth > 0
  return { x: v.cx + v.R * r * xe, y: v.cy - v.R * r * yn, visible }
}

/** Polyline through visible samples only, broken where it goes behind the globe. */
function visiblePath(v: View, pts: [number, number][], r = 1): string {
  let d = ''
  let pen = false
  for (const [lat, lon] of pts) {
    const p = project(v, lat, lon, r)
    if (!p.visible) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)} `
    pen = true
  }
  return d
}

/** A circular orbit's sub-points: inclination i, ascending node Ω (deg), sampled every 2°. */
function orbitPoints(iDeg: number, nodeDeg: number, u0 = 0, span = 360): [number, number][] {
  const i = iDeg * (Math.PI / 180)
  const Ω = nodeDeg * (Math.PI / 180)
  const out: [number, number][] = []
  for (let k = 0; k <= span; k += 2) {
    const u = (u0 + k) * (Math.PI / 180)
    const x = Math.cos(Ω) * Math.cos(u) - Math.sin(Ω) * Math.sin(u) * Math.cos(i)
    const y = Math.sin(Ω) * Math.cos(u) + Math.cos(Ω) * Math.sin(u) * Math.cos(i)
    const z = Math.sin(u) * Math.sin(i)
    out.push([Math.asin(z) * (180 / Math.PI), Math.atan2(y, x) * (180 / Math.PI)])
  }
  return out
}

/** Argument of latitude u and node Ω so an orbit of inclination i passes over (lat, lon). */
function orbitThrough(iDeg: number, lat: number, lon: number): { node: number; u: number } {
  const i = iDeg * (Math.PI / 180)
  const u = Math.asin(Math.sin(lat * (Math.PI / 180)) / Math.sin(i))
  const node = lon - Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u)) * (180 / Math.PI)
  return { node, u: u * (180 / Math.PI) }
}

function globePlate(): ReactElement {
  const S = PLATE
  const v: View = { lat0: 30, lon0: -74, cx: S / 2 + 10, cy: S / 2 + 64, R: 272 }
  const els: ReactElement[] = []
  const rad = Math.PI / 180

  // Disk, graticule (15°), equator, limb.
  let grat = ''
  for (let lat = -75; lat <= 75; lat += 15) {
    const pts: [number, number][] = []
    for (let lon = -180; lon <= 180; lon += 2) pts.push([lat, lon])
    grat += visiblePath(v, pts)
  }
  for (let lon = -180; lon < 180; lon += 15) {
    const pts: [number, number][] = []
    for (let lat = -88; lat <= 88; lat += 2) pts.push([lat, lon])
    grat += visiblePath(v, pts)
  }
  const eq: [number, number][] = []
  for (let lon = -180; lon <= 180; lon += 2) eq.push([0, lon])
  els.push(h('circle', { cx: v.cx, cy: v.cy, r: v.R, fill: C.ink1 }))
  els.push(h('path', { d: grat, fill: 'none', stroke: 'rgba(236,232,224,0.085)', strokeWidth: 1 }))
  els.push(h('path', { d: visiblePath(v, eq), fill: 'none', stroke: 'rgba(236,232,224,0.18)', strokeWidth: 1 }))
  els.push(h('circle', { cx: v.cx, cy: v.cy, r: v.R, fill: 'none', stroke: 'rgba(236,232,224,0.45)', strokeWidth: 1.25 }))

  // Ground tracks of a few orbital shells: the ISS, a Starlink shell, a sun-synchronous imager.
  const shells: { i: number; node: number; o: number }[] = [
    { i: 51.6, node: -18, o: 0.34 },
    { i: 53.0, node: -158, o: 0.22 },
    { i: 97.8, node: -118, o: 0.26 },
  ]
  for (const sh of shells) {
    els.push(h('path', { d: visiblePath(v, orbitPoints(sh.i, sh.node)), fill: 'none', stroke: `rgba(236,232,224,${sh.o})`, strokeWidth: 1 }))
  }

  // The place, and the pass that matters: a Sentinel-2-like imager (98.6°, 786 km, 290 km swath)
  // on a descending daytime pass, just past the place, its swath ribbon on the ground below.
  const place = { lat: 43.47, lon: -80.54 }
  const asc = orbitThrough(98.6, place.lat, place.lon)
  const uDesc = 180 - asc.u
  // The descending crossing of this latitude lies on a different node; solve for it.
  const node = place.lon - Math.atan2(Math.cos(98.6 * rad) * Math.sin(uDesc * rad), Math.cos(uDesc * rad)) / rad
  const alt = 1 + 786 / 6371
  const from = uDesc - 64
  const span = 71
  const tail = project(v, ...orbitPoints(98.6, node, from, 0)[0], alt)
  const head = project(v, ...orbitPoints(98.6, node, from + span, 0)[0], alt)
  els.push(
    h(
      'defs',
      null,
      h(
        'linearGradient',
        { id: 'pass', gradientUnits: 'userSpaceOnUse', x1: tail.x, y1: tail.y, x2: head.x, y2: head.y },
        h('stop', { offset: '0', stopColor: C.signal, stopOpacity: 0 }),
        h('stop', { offset: '1', stopColor: C.signal, stopOpacity: 1 }),
      ),
      h(
        'linearGradient',
        { id: 'swath', gradientUnits: 'userSpaceOnUse', x1: tail.x, y1: tail.y, x2: head.x, y2: head.y },
        h('stop', { offset: '0', stopColor: C.signal, stopOpacity: 0 }),
        h('stop', { offset: '1', stopColor: C.signal, stopOpacity: 0.3 }),
      ),
    ),
  )
  const swathPx = (290 / 6371) * v.R
  els.push(h('path', { d: visiblePath(v, orbitPoints(98.6, node, from, span), 1), fill: 'none', stroke: 'url(#swath)', strokeWidth: swathPx }))
  els.push(h('path', { d: visiblePath(v, orbitPoints(98.6, node, from, span), alt), fill: 'none', stroke: 'url(#pass)', strokeWidth: 1.75 }))
  els.push(h('circle', { cx: head.x, cy: head.y, r: 4.5, fill: C.signal }))
  const pp = project(v, place.lat, place.lon)
  els.push(...reticle(pp.x, pp.y, 12))
  els.push(cornerTicks(S, 22, 16, C.bone3))

  // Parallel labels just inside the left limb, like the scale on an instrument face.
  const labels: ReactElement[] = []
  for (const lat of [0, 30, 60]) {
    // Find the westernmost visible point of this parallel.
    let best: { x: number; y: number } | null = null
    for (let lon = -180; lon <= 180; lon += 1) {
      const q = project(v, lat, lon)
      if (q.visible && (!best || q.x < best.x)) best = { x: q.x, y: q.y }
    }
    if (best && best.y > 40 && best.y < S - 40) {
      labels.push(mono(lat === 0 ? '0°' : `${lat}°N`, 11, C.bone3, { position: 'absolute', left: best.x + 12, top: best.y - 16 }))
    }
  }

  return box(
    { position: 'relative', width: S, height: S, background: C.ink0, overflow: 'hidden' },
    h('svg', { width: S, height: S, viewBox: `0 0 ${S} ${S}`, style: { position: 'absolute', left: 0, top: 0 } }, ...els),
    ...labels,
  )
}

// ── Right panel ─────────────────────────────────────────────────────────────────────────────

function topRow(right: string): ReactElement {
  return box(
    { width: '100%', justifyContent: 'space-between', alignItems: 'center' },
    box({ alignItems: 'center', gap: 12 }, box({ width: 9, height: 9, background: C.signal }), mono('Overflight', 16, C.bone)),
    mono(right, 15, C.bone3),
  )
}

/** Words as flex items so mixed faces wrap like running text (satori has no inline formatting). */
function headlineWords(lead: string, accent: string, tail: string, size: number): ReactElement {
  const word = (w: string, serif: boolean, key: number) =>
    h(
      'span',
      {
        key,
        style: {
          fontFamily: serif ? FONT.serif : FONT.display,
          fontStyle: serif ? 'italic' : 'normal',
          fontWeight: serif ? 400 : 600,
          // Instrument Serif sits smaller than the condensed sans at the same size; match cap height.
          fontSize: serif ? size * 1.1 : size,
          letterSpacing: serif ? 0 : -0.02 * size,
          lineHeight: 1,
          marginRight: size * 0.2,
          color: C.bone,
        },
      },
      w,
    )
  const leadWords = lead.split(' ').filter(Boolean)
  const accentWords = accent.split(' ').filter(Boolean)
  const items: ReactElement[] = leadWords.map((w, i) => word(w, false, i))
  accentWords.forEach((w, i) => items.push(word(i === accentWords.length - 1 ? w + tail : w, true, 100 + i)))
  return box({ flexWrap: 'wrap', alignItems: 'baseline', width: '100%', rowGap: size * 0.06 }, items)
}

/** Fit the display size to the copy length: big when short, never below 46px. */
export function headlineSize(chars: number): number {
  if (chars <= 26) return 84
  if (chars <= 34) return 76
  if (chars <= 44) return 66
  if (chars <= 58) return 56
  return 48
}

function readout(label: string, value: string, unit: string | null, first: boolean): ReactElement {
  return box(
    { flexDirection: 'column', gap: 10, flex: 1, paddingLeft: first ? 0 : 22, borderLeft: first ? 'none' : `1px solid ${C.line}` },
    mono(label, 13, C.bone3),
    box(
      { alignItems: 'baseline', gap: unit === '°' ? 1 : unit === '%' ? 3 : 8 },
      h('div', { style: { display: 'flex', fontFamily: FONT.mono, fontSize: 30, letterSpacing: -0.3, color: C.bone, lineHeight: 1 } }, value),
      // Symbols hug the number (98.6°, 25%); word units sit apart in caps (786 KM), per DESIGN §3.
      unit === '°' ? h('div', { style: { display: 'flex', fontFamily: FONT.mono, fontSize: 26, color: C.bone3, lineHeight: 1 } }, '°')
      : unit === '%' ? h('div', { style: { display: 'flex', fontFamily: FONT.mono, fontSize: 19, color: C.bone3, lineHeight: 1 } }, '%')
      : unit ? mono(unit, 14, C.bone3) : null,
    ),
  )
}

function fmtVal(n: number | undefined, digits: number): string {
  return n === undefined ? '—' : n.toFixed(digits)
}

function readouts(share: ShareRecord): ReactElement {
  const p = share.pass
  const third =
    share.verdict === 'imaged'
      ? readout('Cloud', fmtVal(share.capture?.cloudCoverPct, 0), share.capture?.cloudCoverPct !== undefined ? '%' : null, false)
      : readout('Closest', fmtVal(p.groundDistanceKm, 0), p.groundDistanceKm !== undefined ? 'KM' : null, false)
  return box(
    { width: '100%' },
    readout('Alt', fmtVal(p.altitudeKm, 0), p.altitudeKm !== undefined ? 'KM' : null, true),
    readout('Off-nadir', fmtVal(p.offNadirDeg, 1), p.offNadirDeg !== undefined ? '°' : null, false),
    third,
  )
}

function panel(children: Child[]): ReactElement {
  return box(
    { flexDirection: 'column', width: PANEL_W, height: CARD_H, padding: `40px ${PAD_X}px 34px ${PAD_X - 4}px`, borderLeft: `1px solid ${C.bone4}` },
    children,
  )
}

function footer(left: string, host: string): ReactElement {
  return box(
    { flexDirection: 'column', width: '100%', gap: 14 },
    hairline(),
    box({ width: '100%', justifyContent: 'space-between' }, mono(left, 13, C.bone3), host ? mono(host, 13, C.bone2, { textTransform: 'none', letterSpacing: 0.4 }) : null),
  )
}

// ── Cards ───────────────────────────────────────────────────────────────────────────────────

export interface ShareCardInput {
  share: ShareRecord
  image: { dataUri: string; plan: CropPlan } | null
  /**
   * Why an `imaged` share has no image on the card: the archive was slow or down right now
   * ('transient'), or this capture can't be cropped server-side at all ('permanent', e.g. an
   * Earth Search fallback item). Ignored for other verdicts.
   */
  imageMiss?: 'transient' | 'permanent'
  host: string
}

export function shareCard({ share, image, imageMiss = 'transient', host }: ShareCardInput): ReactElement {
  const t = momentOf(share)
  const parts = headlineParts(share)
  const { lead } = parts
  const cps = Array.from(parts.place) // code points: never split a surrogate pair
  const placeShort = cps.length > 48 ? `${cps.slice(0, 47).join('').trimEnd()}…` : parts.place
  // "…." reads as a typo: a truncated place ends on the ellipsis alone.
  const tail = placeShort.endsWith('…') ? '' : parts.tail
  const size = headlineSize(lead.length + Array.from(placeShort).length + 1)
  const plateNote =
    share.verdict === 'imaged'
      ? imageMiss === 'permanent'
        ? 'Image opens in the app'
        : 'Image unavailable right now'
      : share.verdict === 'could'
        ? 'Commercial archive, not public'
        : share.verdict === 'likely'
          ? 'In swath, no public image yet'
          : 'Ground track at closest approach'

  return box(
    { width: CARD_W, height: CARD_H, background: C.ink0, fontFamily: FONT.sans, color: C.bone },
    image ? imagePlate(share, image.dataUri, image.plan) : geometryPlate(share, plateNote),
    panel([
      topRow(share.norad ? `NORAD ${share.norad}` : satLabel(share)),
      hairline({ marginTop: 22 }),
      box(
        { width: '100%', justifyContent: 'space-between', alignItems: 'center', marginTop: 18 },
        box({ alignItems: 'center', gap: 10 }, verdictGlyph(share.verdict), mono(VERDICT_TAG[share.verdict], 14, share.verdict === 'imaged' || share.verdict === 'likely' ? C.signal : C.bone2)),
        mono(t !== undefined ? fmtUtc(t) : '—', 14, C.bone2),
      ),
      box({ flex: 1, alignItems: 'center', width: '100%' }, headlineWords(lead, placeShort, tail, size)),
      hairline({ marginBottom: 20 }),
      readouts(share),
      box({ height: 30 }),
      footer(fmtLatLon(share.lat, share.lon), host),
    ]),
  )
}

/** The homepage card: the hero line over an instrument drawing of Earth and its orbital shells. */
export function defaultCard({ host }: { host: string }): ReactElement {
  return box(
    { width: CARD_W, height: CARD_H, background: C.ink0, fontFamily: FONT.sans, color: C.bone },
    globePlate(),
    panel([
      topRow('Last 7 days'),
      hairline({ marginTop: 22 }),
      box(
        { flex: 1, flexDirection: 'column', justifyContent: 'center', width: '100%', gap: 30 },
        headlineWordsHero(),
        h(
          'div',
          { style: { display: 'flex', fontFamily: FONT.sans, fontSize: 23, lineHeight: 1.42, color: C.bone2, maxWidth: 440 } },
          'Enter any place on Earth. See every satellite that passed over it in the last 7 days, and the actual pictures they took.',
        ),
      ),
      footer('Sentinel-2 · Landsat · GOES', host),
    ]),
  )
}

function headlineWordsHero(): ReactElement {
  const size = 80
  const w = (s: string, serif = false) =>
    h(
      'span',
      {
        style: {
          fontFamily: serif ? FONT.serif : FONT.display,
          fontStyle: serif ? 'italic' : 'normal',
          fontWeight: serif ? 400 : 600,
          fontSize: serif ? size * 1.16 : size,
          letterSpacing: serif ? 0 : -0.02 * size,
          lineHeight: 0.98,
          marginRight: size * 0.2,
          color: C.bone,
        },
      },
      s,
    )
  return box({ flexWrap: 'wrap', alignItems: 'baseline', width: '100%' }, w('Something'), w('photographed'), w('you', true), w('this'), w('week.'))
}
