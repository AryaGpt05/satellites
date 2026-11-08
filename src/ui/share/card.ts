/**
 * The share card's content (shared by the DOM preview and the PNG renderer), and the PNG renderer.
 *
 * 1200 × 630 (OG size). Left: the real crop, centred on the ROUNDED place (privacy), with the reticle.
 * Right: wordmark, condensed headline ("Sentinel-2C photographed / Waterloo."), date and time at the
 * place, three readouts, rounded coordinates. No image (could / likely / overhead) → plan view instead.
 */
import { gibsWmsUrl, pcCropUrl, preloadImage } from '@/imagery'
import type { Capture, Pass, Report } from '@/types'
import { palette } from '@/ui/system/palette'
import { captureFor, cropSpec, isDailyMosaic, sensorName } from '../results/lib/captures'
import { dec1, int, shareHeadline } from '../results/lib/copy'
import type { SatMeta } from '../results/lib/meta'
import { planGeometry } from '../results/lib/plan'
import { fmtLocalTime, localParts, zoneAbbr } from '../results/lib/time'
import { roundedPlace } from './links'

export const CARD_W = 1200
export const CARD_H = 630

export interface CardSpec {
  lead: string
  place: string
  /** "Sun 1 Nov 2026" */
  date: string
  /** "11:21:13 EST" */
  time: string
  readouts: { label: string; value: string; unit?: string }[]
  /** rounded, e.g. "43.47°N 80.54°W" */
  coords: string
  /** image to show on the left (crop centred on the rounded place), if any */
  imageUrl?: string
  /** small caption over the left square, e.g. "Sentinel-2C · MSI · 10 m" or "Flock 4Q-13 · ground track · swath 32 km" */
  imageLabel?: string
  verdict: Pass['verdict']
  host: string
}

const fmtCoord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`

/** Crop URL centred on an arbitrary point (the rounded share point), per provider. */
export function cropAt(capture: Capture, lat: number, lon: number, px: number): string {
  const spec = { ...cropSpec(capture.collection), px }
  if (capture.provider === 'planetary-computer' && (capture.collection === 'sentinel-2-l2a' || capture.collection === 'landsat-c2-l2')) {
    return pcCropUrl(capture.collection, capture.itemId, { lat, lon }, spec).replace(/\.png\?/, '.jpg?')
  }
  if (capture.provider === 'gibs') {
    const [layer, time] = capture.itemId.split('@')
    if (layer && time) return gibsWmsUrl(layer, time, { lat, lon }, spec)
  }
  return capture.cropUrl(spec)
}

export function cardSpec(pass: Pass, report: Report, meta: SatMeta, timeZone: string, host: string): CardSpec {
  const place = report.place
  const r = roundedPlace(place.lat, place.lon)
  const capture = captureFor(report, pass)
  const h = shareHeadline(pass.verdict, meta.name, place.label)
  const p = localParts(pass.tClosest, timeZone)
  const readouts: CardSpec['readouts'] = [{ label: 'Altitude', value: int(pass.altitudeKm), unit: 'km' }]
  if (pass.verdict === 'overhead') {
    readouts.push({ label: 'Elevation', value: `${int(pass.elevationDeg)}°` }, { label: 'Speed', value: dec1(pass.groundSpeedKmS), unit: 'km/s' })
  } else {
    const res = capture?.gsdM ?? meta.profile?.resolutionM
    readouts.push(
      { label: 'Off-nadir', value: `${dec1(pass.offNadirDeg)}°` },
      res !== undefined
        ? {
            // Without an image this is the instrument's best resolution, not a pixel of anything shown.
            label: capture ? (isDailyMosaic(capture) ? 'Mosaic pixel' : 'Pixel') : 'Resolution',
            value: res < 1 ? res.toFixed(2) : int(res),
            unit: 'm',
          }
        : { label: 'Distance', value: int(pass.groundDistanceKm), unit: 'km' },
    )
  }
  return {
    lead: h.lead,
    place: h.place,
    date: `${p.weekday} ${p.day} ${p.monthName} ${p.year}`,
    time: `${fmtLocalTime(pass.tClosest, timeZone, true)} ${zoneAbbr(pass.tClosest, timeZone)}`,
    readouts,
    coords: `${fmtCoord(r.lat, 'N', 'S')} ${fmtCoord(r.lon, 'E', 'W')}`,
    imageUrl: capture ? cropAt(capture, r.lat, r.lon, 640) : undefined,
    imageLabel: capture ? `${meta.name} · ${sensorName(capture)} · ${int(capture.gsdM)} m` : planLabel(meta),
    verdict: pass.verdict,
    host,
  }
}

/** Caption for the plan view (no image): what the line and the band are. */
function planLabel(meta: SatMeta): string {
  const p = meta.profile
  const field = p?.maxOffNadirDeg ? `field of regard ±${int(p.maxOffNadirDeg)}°` : p?.swathKm ? `swath ${int(p.swathKm)} km` : undefined
  return [meta.name, 'ground track', field].filter(Boolean).join(' · ')
}

/** Headline size so long satellite names still fit three lines in the right column. */
export function headlineSize(lead: string): number {
  const n = lead.length
  if (n <= 24) return 84
  if (n <= 32) return 72
  if (n <= 42) return 62
  return 54
}

// ── PNG ───────────────────────────────────────────────────────────────────────────────────

const SANS = '"Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif'
const MONO = '"Martian Mono Variable", "Martian Mono", ui-monospace, monospace'
const SERIF = '"Instrument Serif", Georgia, serif'

type Ctx = CanvasRenderingContext2D & { fontStretch?: string; letterSpacing?: string }

function wrap(ctx: Ctx, text: string, maxW: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line)
      line = w
    } else line = test
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Render the card to a PNG blob on a canvas (fonts are the page's own web fonts; the crop is CORS-clean
 * because every archive sends `Access-Control-Allow-Origin: *` and preloadImage asks anonymously).
 * `drawPlan` paints the left square when there is no image.
 */
export async function renderCardPng(spec: CardSpec, drawPlan?: (ctx: CanvasRenderingContext2D, size: number) => void): Promise<Blob> {
  const fontsToLoad = [`560 84px ${SANS}`, `400 20px ${MONO}`, `italic 400 84px ${SERIF}`]
  try {
    await Promise.all(fontsToLoad.map((f) => document.fonts?.load(f)))
  } catch {
    /* fall back to whatever is available */
  }
  const img = spec.imageUrl ? await preloadImage(spec.imageUrl).catch(() => null) : null

  const cv = document.createElement('canvas')
  cv.width = CARD_W
  cv.height = CARD_H
  const ctx = cv.getContext('2d') as Ctx | null
  if (!ctx) throw new Error('Canvas unavailable')
  const S = CARD_H // left square size

  // ground
  ctx.fillStyle = palette.ink0
  ctx.fillRect(0, 0, CARD_W, CARD_H)

  // left: image or plan
  if (img) ctx.drawImage(img, 0, 0, S, S)
  else if (drawPlan) drawPlan(ctx, S)
  // reticle at the centre of the left square
  const c = S / 2
  ctx.strokeStyle = palette.signal
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(c, c, 22, 0, Math.PI * 2)
  ctx.moveTo(c, c - 46)
  ctx.lineTo(c, c - 30)
  ctx.moveTo(c, c + 30)
  ctx.lineTo(c, c + 46)
  ctx.moveTo(c - 46, c)
  ctx.lineTo(c - 30, c)
  ctx.moveTo(c + 30, c)
  ctx.lineTo(c + 46, c)
  ctx.stroke()
  ctx.fillStyle = palette.signal
  ctx.fillRect(c - 2, c - 2, 4, 4)
  // image label chip
  ctx.font = `400 15px ${MONO}`
  ctx.textBaseline = 'middle'
  if (spec.imageLabel) {
    const label = spec.imageLabel.toUpperCase()
    const w = ctx.measureText(label).width + 20
    ctx.fillStyle = 'rgba(7,8,10,0.8)'
    ctx.fillRect(18, 18, w, 30)
    ctx.fillStyle = palette.bone
    ctx.fillText(label, 28, 34)
  }
  // divider
  ctx.fillStyle = 'rgba(236,232,224,0.22)'
  ctx.fillRect(S, 0, 1, CARD_H)

  // right column
  const x = S + 52
  const right = CARD_W - 52
  const maxW = right - x
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = palette.bone
  ctx.font = `400 16px ${MONO}`
  if ('letterSpacing' in ctx) ctx.letterSpacing = '2px'
  ctx.fillText('OVERFLIGHT', x, 74)
  ctx.fillStyle = 'rgba(236,232,224,0.4)'
  const tagline = 'WHAT PHOTOGRAPHED YOU THIS WEEK'
  ctx.font = `400 12px ${MONO}`
  ctx.fillText(tagline, x, 98)
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'

  // headline
  const size = headlineSize(spec.lead)
  ctx.font = `560 ${size}px ${SANS}`
  if ('fontStretch' in ctx) ctx.fontStretch = 'condensed'
  const lines = wrap(ctx, spec.lead, maxW)
  let y = 196 + (size * 0.92 * Math.max(0, 3 - lines.length - 1)) / 2
  ctx.fillStyle = palette.bone
  for (const l of lines) {
    ctx.fillText(l, x, y)
    y += size * 0.94
  }
  if ('fontStretch' in ctx) ctx.fontStretch = 'normal'
  ctx.font = `italic 400 ${Math.round(size * 1.06)}px ${SERIF}`
  ctx.fillText(`${spec.place}.`, x, y)
  y += 52

  // date + time
  ctx.font = `400 18px ${MONO}`
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1px'
  ctx.fillStyle = 'rgba(236,232,224,0.64)'
  ctx.fillText(`${spec.date} · ${spec.time}`.toUpperCase(), x, Math.max(y, 430))

  // readouts
  const ry = 488
  ctx.fillStyle = 'rgba(236,232,224,0.18)'
  ctx.fillRect(x, ry - 22, maxW, 1)
  const colW = maxW / spec.readouts.length
  spec.readouts.forEach((r, i) => {
    const cx = x + i * colW
    ctx.font = `400 12px ${MONO}`
    ctx.fillStyle = 'rgba(236,232,224,0.4)'
    ctx.fillText(r.label.toUpperCase(), cx, ry)
    ctx.font = `300 30px ${MONO}`
    ctx.fillStyle = palette.bone
    if ('letterSpacing' in ctx) ctx.letterSpacing = '-1px'
    ctx.fillText(r.value, cx, ry + 40)
    const vw = ctx.measureText(r.value).width
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1px'
    if (r.unit) {
      ctx.font = `400 15px ${MONO}`
      ctx.fillStyle = 'rgba(236,232,224,0.4)'
      ctx.fillText(r.unit.toUpperCase(), cx + vw + 8, ry + 40)
    }
  })

  // footer
  ctx.font = `400 13px ${MONO}`
  ctx.fillStyle = 'rgba(236,232,224,0.4)'
  ctx.fillText(spec.coords, x, CARD_H - 44)
  const host = spec.host.toUpperCase()
  ctx.fillText(host, right - ctx.measureText(host).width, CARD_H - 44)
  // signal mark: an image exists
  if (spec.verdict === 'imaged') {
    const mx = right - 8
    const my = 66
    ctx.fillStyle = palette.signal
    ctx.beginPath()
    ctx.moveTo(mx, my - 8)
    ctx.lineTo(mx + 8, my)
    ctx.lineTo(mx, my + 8)
    ctx.lineTo(mx - 8, my)
    ctx.closePath()
    ctx.fill()
  }

  return new Promise<Blob>((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'))
}

/** Paint the plan view (no image) into the left square of the PNG card. */
export function planPainter(pass: Pass, meta: SatMeta, lat: number, lon: number) {
  return (ctx: CanvasRenderingContext2D, size: number) => {
    const g = planGeometry(pass, meta, lat, lon)
    const k = size / (2 * g.extent)
    const X = (v: { x: number; y: number }) => [size / 2 + v.x * k, size / 2 + v.y * k] as const
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, size, size)
    ctx.clip()
    ctx.strokeStyle = 'rgba(236,232,224,0.08)'
    ctx.lineWidth = 1
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.beginPath()
      ctx.moveTo(0, size * f + 0.5)
      ctx.lineTo(size, size * f + 0.5)
      ctx.moveTo(size * f + 0.5, 0)
      ctx.lineTo(size * f + 0.5, size)
      ctx.stroke()
    }
    if (g.band) {
      ctx.fillStyle = 'rgba(236,232,224,0.05)'
      ctx.beginPath()
      g.band.forEach((p, i) => (i ? ctx.lineTo(...X(p)) : ctx.moveTo(...X(p))))
      ctx.closePath()
      ctx.fill()
      ctx.setLineDash([4, 5])
      ctx.strokeStyle = 'rgba(236,232,224,0.3)'
      ctx.beginPath()
      ctx.moveTo(...X(g.band[0]))
      ctx.lineTo(...X(g.band[1]))
      ctx.moveTo(...X(g.band[3]))
      ctx.lineTo(...X(g.band[2]))
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.strokeStyle = 'rgba(236,232,224,0.7)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    g.track.forEach((p, i) => (i ? ctx.lineTo(...X(p)) : ctx.moveTo(...X(p))))
    ctx.stroke()
    const [sx, sy] = X(g.sub)
    ctx.fillStyle = palette.bone
    ctx.save()
    ctx.translate(sx, sy)
    ctx.rotate(Math.PI / 4)
    ctx.fillRect(-6, -6, 12, 12)
    ctx.restore()
    ctx.setLineDash([2, 5])
    ctx.strokeStyle = 'rgba(236,232,224,0.45)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(size / 2, size / 2)
    ctx.lineTo(sx, sy)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }
}
