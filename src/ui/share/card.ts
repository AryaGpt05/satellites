/**
 * The share card in the browser: its spec (from the shared builder in api/_lib/cardSpec.ts, so the
 * preview, this PNG and the server's Open Graph card print identical fields) and the PNG renderer.
 *
 * 1200 × 630 (OG size). Left: the real crop, centred on the ROUNDED place (privacy), with the reticle,
 * source chip, scale bar and the archive's credit; or the pass geometry when there is no picture.
 * Right: wordmark + local time, verdict row, headline, three readouts, the invitation footer.
 *
 * The plate (share R2SH1): the pass view has already decoded a larger crop of the same scene around the
 * searched point (1024 px, ±5 km for Sentinel-2). The card's square, centred on the rounded share point,
 * lies inside it, so `cardSource` maps that square into the decoded picture's pixels and the preview and
 * the PNG cut it out: no second render from the archive, no "Acquiring" plate, a PNG ready in well under
 * a second. Only that rect is ever drawn (the DOM preview clips to it too), so the card shows exactly the
 * ground a fresh crop centred on the rounded point would show. When the pass view's picture isn't in
 * the cache (a summary's best look, a recipient's first look), the same rect is loaded and faded in.
 */
import { gibsWmsUrl, pcCropUrl, preloadImage } from '@/imagery'
import { bboxAround } from '@/lib/geo'
import type { Capture, Pass, Report } from '@/types'
import {
  CARD_COLOR as C,
  CARD_FS,
  CARD_H,
  CARD_W,
  CHIP_BOX,
  HEAD,
  PANEL,
  PLATE,
  TONE_COLOR,
  TRACK,
  buildCardSpec,
  buildSummarySpec,
  hatchPath,
  plateOrFallback,
  verdictGlyphPrims,
  type CardCrop,
  type CardSpec,
  type Chip,
  type PlanPlate,
  type PlateSource,
  type Prim,
  type ScaleBar,
} from '../../../api/_lib/cardSpec'
import { pickBestLook } from '../results/lib/bestLook'
import { captureFor, cropSpec, displayUrl, isDetailed } from '../results/lib/captures'
import type { SatMeta } from '../results/lib/meta'
import { roundedPlace, type SummaryLinkInput } from './links'

export { CARD_H, CARD_W, PLATE, type CardSpec, type PlateSource }

export interface CardOptions {
  /** The picture is mostly cloud (results' isClouded): the clouded variant. */
  clouded?: boolean
}

/** Crop URL for a capture at the card's scale, centred on an arbitrary point (the rounded share point). */
export function cropUrlFor(capture: Pick<Capture, 'provider' | 'collection' | 'itemId' | 'cropUrl'>, crop: CardCrop, lat: number, lon: number): string | undefined {
  const opts = { halfSizeKm: crop.halfSizeKm, px: PLATE }
  if (capture.provider === 'planetary-computer' && (capture.collection === 'sentinel-2-l2a' || capture.collection === 'landsat-c2-l2')) {
    // Planetary Computer renders the same crop as JPEG at a fraction of the PNG's size.
    return pcCropUrl(capture.collection, capture.itemId, { lat, lon }, opts).replace(/\.png\?/, '.jpg?')
  }
  if (capture.provider === 'gibs') {
    const [layer, time] = capture.itemId.split('@')
    return layer && time ? gibsWmsUrl(layer, time, { lat, lon }, opts) : undefined
  }
  try {
    return capture.cropUrl(opts)
  } catch {
    return undefined
  }
}

/** Display URLs whose pixels map linearly to a lon/lat box: Planetary Computer bbox crops and GIBS WMS (EPSG:4326). */
const LINEAR_CROP = /^https:\/\/(planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/|gibs\.earthdata\.nasa\.gov\/wms\/epsg4326\/[^?]*\?.*BBOX=)/

/**
 * Where the card's square sits inside the picture the pass view decoded (share R2SH1).
 *
 * The pass view shows displayUrl(capture, cropSpec(collection)): a `spec.px` square over
 * bboxAround(exact, spec.halfSizeKm), rendered in plain lon/lat (EPSG:4326), so source pixels are linear
 * in longitude and latitude. The card's crop is bboxAround(rounded, crop.halfSizeKm). Undefined when that
 * box leaves the source on any side, or when the capture has no such crop (an Earth Search thumbnail).
 */
export function cardSource(
  capture: Pick<Capture, 'collection' | 'cropUrl'>,
  exact: { lat: number; lon: number },
  rounded: { lat: number; lon: number },
  crop: Pick<CardCrop, 'halfSizeKm'>,
): PlateSource | undefined {
  const spec = cropSpec(capture.collection)
  let url: string
  try {
    url = displayUrl(capture, spec)
  } catch {
    return undefined
  }
  if (!url || !LINEAR_CROP.test(url)) return undefined
  const D = bboxAround(exact.lat, exact.lon, spec.halfSizeKm)
  const Cb = bboxAround(rounded.lat, rounded.lon, crop.halfSizeKm)
  const kx = spec.px / (D[2] - D[0])
  const ky = spec.px / (D[3] - D[1])
  const sx = (Cb[0] - D[0]) * kx
  const sy = (D[3] - Cb[3]) * ky
  const sw = (Cb[2] - Cb[0]) * kx
  const sh = (Cb[3] - Cb[1]) * ky
  const ok = (v: number) => Number.isFinite(v) && v >= 0 && v <= spec.px
  if (!ok(sx) || !ok(sy) || !ok(sx + sw) || !ok(sy + sh) || sw <= 0 || sh <= 0) return undefined
  return { url, sx, sy, sw, sh, px: spec.px }
}

/** The card for a pass, as the sharer sees it (the server builds the same from the stored share). */
export function cardSpec(pass: Pass, report: Report, meta: SatMeta, timeZone: string, host: string, opts: CardOptions = {}): CardSpec {
  const r = roundedPlace(report.place.lat, report.place.lon)
  const capture = captureFor(report, pass)
  const spec = buildCardSpec({
    verdict: pass.verdict,
    satName: meta.name,
    placeLabel: report.place.label,
    lat: r.lat,
    lon: r.lon,
    tClosest: pass.tClosest,
    timeZone,
    pass,
    capture: capture
      ? {
          collection: capture.collection,
          itemId: capture.itemId,
          provider: capture.provider,
          platform: capture.platform,
          gsdM: capture.gsdM,
          cloudCoverPct: capture.cloudCoverPct,
          spot: capture.spot,
          datetime: capture.datetime,
        }
      : undefined,
    clouded: opts.clouded,
    host,
  })
  if (spec.plate.kind === 'image' && capture) {
    spec.plate.imageUrl = cropUrlFor(capture, spec.plate.crop, r.lat, r.lon)
    // report.place is the exact searched point (ShareSheet swaps only its label): the pass view's crop is centred there.
    spec.plate.source = cardSource(capture, report.place, r, spec.plate.crop)
  }
  return spec
}

/**
 * The week at a place (share SH6): the four counts, the best look, and the satellites that photographed
 * it in detail (R2SH5): distinct satellites with a detailed picture (Sentinel-2 / Landsat), as the
 * results headline counts them. Weather mosaics (250–375 m) don't count.
 */
export function summaryFacts(report: Report, placeLabel: string, satName: (norad: number) => string): SummaryLinkInput & { best?: SummaryLinkInput['best'] & { altitudeKm: number; capture: Capture } } {
  const counts = { imaged: 0, likely: 0, could: 0, overhead: 0 }
  const photographed = new Set<number>()
  for (const p of report.passes) {
    counts[p.verdict]++
    if (p.verdict !== 'imaged') continue
    const c = captureFor(report, p)
    if (c && isDetailed(c)) photographed.add(p.norad)
  }
  const look = pickBestLook(report)
  const best =
    look && look.kind !== 'geo'
      ? {
          collection: look.capture.collection,
          itemId: look.capture.itemId,
          satName: satName(look.pass.norad),
          tClosest: look.pass.tClosest,
          gsdM: look.capture.gsdM,
          altitudeKm: look.pass.altitudeKm,
          capture: look.capture,
        }
      : undefined
  return { label: placeLabel, lat: report.place.lat, lon: report.place.lon, satellites: photographed.size, counts, windowEnd: report.windowEnd, best }
}

/** The summary card, as the sharer sees it (the server builds the same from the link's parameters). */
export function summaryCardSpec(report: Report, placeLabel: string, satName: (norad: number) => string, timeZone: string, host: string): CardSpec {
  const f = summaryFacts(report, placeLabel, satName)
  const r = roundedPlace(report.place.lat, report.place.lon)
  const c = f.best?.capture
  const spec = buildSummarySpec({
    placeLabel,
    lat: r.lat,
    lon: r.lon,
    satellites: f.satellites,
    counts: f.counts,
    windowEnd: f.windowEnd,
    timeZone,
    best: f.best && c ? { satName: f.best.satName, tClosest: f.best.tClosest, capture: { collection: c.collection, itemId: c.itemId, gsdM: c.gsdM } } : undefined,
    host,
  })
  if (spec.plate.kind === 'image' && c) {
    spec.plate.imageUrl = cropUrlFor(c, spec.plate.crop, r.lat, r.lon)
    spec.plate.source = cardSource(c, report.place, r, spec.plate.crop)
  }
  return spec
}

// ── Canvas ──────────────────────────────────────────────────────────────────────────────────

const SANS = '"Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif'
const MONO = '"Martian Mono Variable", "Martian Mono", ui-monospace, monospace'
const SERIF = '"Instrument Serif", Georgia, serif'

type Ctx = CanvasRenderingContext2D & { fontStretch?: string; letterSpacing?: string }
interface Face {
  family: string
  size: number
  weight?: number
  italic?: boolean
  /** CSS font-stretch keyword: mono is 87.5 % (semi-condensed), display 75 % (condensed) */
  stretch?: 'normal' | 'condensed' | 'semi-condensed'
  /** px */
  tracking?: number
}

const monoFace = (size: number, tracking = size * TRACK.label, weight = 350): Face => ({ family: MONO, size, weight, stretch: 'semi-condensed', tracking })

function setFace(ctx: Ctx, f: Face) {
  const lead = `${f.italic ? 'italic ' : ''}${f.weight ?? 400}`
  const stretch = f.stretch ?? 'normal'
  if (Reflect.has(ctx, 'fontStretch')) {
    ctx.font = `${lead} ${f.size}px ${f.family}`
    ctx.fontStretch = stretch
  } else if (stretch !== 'normal') {
    // No ctx.fontStretch (Safari): put the keyword in the font shorthand, and fall back to the plain
    // face if this canvas rejects it (an invalid assignment leaves the previous font in place).
    ctx.font = '1px serif'
    ctx.font = `${lead} ${stretch} ${f.size}px ${f.family}`
    if (ctx.font === '1px serif') ctx.font = `${lead} ${f.size}px ${f.family}`
  } else ctx.font = `${lead} ${f.size}px ${f.family}`
  if (nativeTracking(ctx)) ctx.letterSpacing = `${f.tracking ?? 0}px`
}

const nativeTracking = (ctx: Ctx) => Reflect.has(ctx, 'letterSpacing')

/** Width of `text` in the current face, tracking included (CSS adds it after every glyph). */
function textWidth(ctx: Ctx, text: string, tracking: number): number {
  if (nativeTracking(ctx)) return ctx.measureText(text).width
  return ctx.measureText(text).width + tracking * Array.from(text).length
}

/** Draw text with tracking even where the canvas has no `letterSpacing` (per-glyph fallback). */
function fillText(ctx: Ctx, text: string, x: number, y: number, tracking: number) {
  if (nativeTracking(ctx) || !tracking) {
    ctx.fillText(text, x, y)
    return
  }
  let cx = x
  for (const ch of Array.from(text)) {
    ctx.fillText(ch, cx, y)
    cx += ctx.measureText(ch).width + tracking
  }
}

/** Baseline of a line box (CSS model): half-leading, then the font's ascent. */
function baselineIn(ctx: Ctx, top: number, lineH: number): number {
  const m = ctx.measureText('Hg')
  const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? lineH * 0.8
  const desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? lineH * 0.2
  return top + (lineH - (asc + desc)) / 2 + asc
}

/** Word wrap that, like the browser and satori, may also break after a hyphen. */
function wrap(ctx: Ctx, text: string, maxW: number, tracking: number): string[] {
  // Words, each hyphenated part kept with its hyphen ("Saint-", "Jean-", "sur-", "Richelieu,"). No
  // regex lookbehind: Safari before 16.4 can't parse one, and this module ships to every browser.
  const tokens = text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => w.replace(/-/g, '-\u0000').split('\u0000').filter(Boolean))
  // Re-attach the separators: a token that ended with "-" joins the next without a space.
  const lines: string[] = []
  let line = ''
  for (const tok of tokens) {
    const sep = line && !line.endsWith('-') ? ' ' : ''
    const test = line + sep + tok
    if (line && textWidth(ctx, test, tracking) > maxW) {
      lines.push(line)
      line = tok
    } else line = test
  }
  if (line) lines.push(line)
  return lines
}

function drawPrims(ctx: Ctx, prims: Prim[]) {
  for (const p of prims) {
    ctx.save()
    if (p.t === 'circle') {
      ctx.beginPath()
      ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2)
      if (p.fill) {
        ctx.fillStyle = p.fill
        ctx.fill()
      }
      if (p.stroke) {
        ctx.strokeStyle = p.stroke
        ctx.lineWidth = p.width ?? 1
        ctx.stroke()
      }
    } else {
      const path = new Path2D(p.d)
      if (p.fill) {
        ctx.fillStyle = p.fill
        ctx.fill(path)
      }
      if (p.stroke || p.grad) {
        if (p.grad) {
          const g = ctx.createLinearGradient(p.grad.x1, p.grad.y1, p.grad.x2, p.grad.y2)
          g.addColorStop(0, p.grad.from)
          g.addColorStop(1, p.grad.to)
          ctx.strokeStyle = g
        } else ctx.strokeStyle = p.stroke!
        ctx.lineWidth = p.width ?? 1
        if (p.dash) ctx.setLineDash(p.dash)
        ctx.stroke(path)
      }
    }
    ctx.restore()
  }
}

/** A flat ink chip: padding, 1px line-strong border, mono segments separated by CHIP_BOX.gap. */
function drawChip(ctx: Ctx, chip: Chip, plateSize = PLATE) {
  const f = monoFace(chip.size)
  setFace(ctx, f)
  const segs = chip.segs.map((s) => ({ ...s, text: s.text.toUpperCase() }))
  const widths = segs.map((s) => textWidth(ctx, s.text, f.tracking!))
  const lineH = chip.size * CHIP_BOX.lineH
  const w = widths.reduce((a, b) => a + b, 0) + CHIP_BOX.gap * (segs.length - 1) + CHIP_BOX.padX * 2 + 2
  const h = lineH + CHIP_BOX.padTop + CHIP_BOX.padBottom + 2
  const { left, right, top, bottom } = chip.pos
  const x = left !== undefined ? left : plateSize - (right ?? 0) - w
  const y = top !== undefined ? top : plateSize - (bottom ?? 0) - h
  ctx.fillStyle = C.chip
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = C.lineStrong
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  const base = baselineIn(ctx, y + 1 + CHIP_BOX.padTop, lineH)
  let cx = x + 1 + CHIP_BOX.padX
  segs.forEach((s, i) => {
    ctx.fillStyle = TONE_COLOR[s.tone]
    fillText(ctx, s.text, cx, base, f.tracking!)
    cx += widths[i] + CHIP_BOX.gap
  })
}

/** ├── 1 KM ──┤ in a chip at the plate's top right. */
function drawScale(ctx: Ctx, s: ScaleBar) {
  if (s.px <= 0) return
  const f = monoFace(CARD_FS.chip)
  setFace(ctx, f)
  const label = s.label.toUpperCase()
  const lw = textWidth(ctx, label, f.tracking!)
  const lineH = CARD_FS.chip * CHIP_BOX.lineH
  const w = s.px + CHIP_BOX.gap + lw + CHIP_BOX.padX * 2 + 2
  const h = lineH + CHIP_BOX.padTop + CHIP_BOX.padBottom + 2
  const x = PLATE - 24 - w
  const y = 24
  ctx.fillStyle = C.chip
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = C.lineStrong
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  const bx = x + 1 + CHIP_BOX.padX
  const cy = y + h / 2
  ctx.fillStyle = C.bone
  ctx.fillRect(bx, cy - 5, 2, 10)
  ctx.fillRect(bx + s.px - 2, cy - 5, 2, 10)
  ctx.fillRect(bx, cy - 1, s.px, 2)
  ctx.fillStyle = C.bone
  fillText(ctx, label, bx + s.px + CHIP_BOX.gap, baselineIn(ctx, y + 1 + CHIP_BOX.padTop, lineH), f.tracking!)
}

function drawPlan(ctx: Ctx, plan: PlanPlate) {
  ctx.fillStyle = C.ink1
  ctx.fillRect(0, 0, PLATE, PLATE)
  drawPrims(ctx, plan.prims)
  plan.chips.forEach((c) => drawChip(ctx, c))
  drawScale(ctx, plan.scale)
}

/** Mono caps text centred vertically in a [top, height] box; `align` right anchors at x. */
function rowText(ctx: Ctx, text: string, x: number, box: readonly [number, number], color: string, face: Face, align: 'left' | 'right' = 'left') {
  setFace(ctx, face)
  const t = text.toUpperCase()
  const w = textWidth(ctx, t, face.tracking ?? 0)
  ctx.fillStyle = color
  fillText(ctx, t, align === 'left' ? x : x - w, baselineIn(ctx, box[0], box[1]), face.tracking ?? 0)
  return w
}

/** The picture for the plate: the pass view's decoded crop when there is one (a cache hit), else the card's own crop. */
async function plateImage(spec: CardSpec): Promise<{ img: HTMLImageElement; rect?: PlateSource } | null> {
  if (spec.plate.kind !== 'image') return null
  const { source, imageUrl } = spec.plate
  if (source) {
    const img = await preloadImage(source.url).catch(() => null)
    if (img) return { img, rect: source }
  }
  const img = imageUrl ? await preloadImage(imageUrl).catch(() => null) : null
  return img ? { img } : null
}

/**
 * Render the card to a PNG blob on a canvas (fonts are the page's own web fonts; the crop is CORS-clean
 * because every archive sends `Access-Control-Allow-Origin: *` and preloadImage asks anonymously).
 *
 * The canvas is CPU-backed (`willReadFrequently`), so toBlob encodes from memory, off the main thread's
 * critical path, instead of first reading the whole card back from the GPU (a long task on phones).
 */
export async function renderCardPng(spec: CardSpec): Promise<Blob> {
  const fontsToLoad = [`560 84px ${SANS}`, `400 24px ${SANS}`, `350 13px ${MONO}`, `500 16px ${MONO}`, `italic 400 84px ${SERIF}`]
  const [, pic] = await Promise.all([
    Promise.all(fontsToLoad.map((f) => document.fonts?.load(f))).catch(() => undefined), // fall back to whatever is available
    plateImage(spec),
  ])
  const img = pic?.img ?? null

  const cv = document.createElement('canvas')
  cv.width = CARD_W
  cv.height = CARD_H
  const ctx = cv.getContext('2d', { willReadFrequently: true }) as Ctx | null
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.textBaseline = 'alphabetic'

  ctx.fillStyle = C.ink0
  ctx.fillRect(0, 0, CARD_W, CARD_H)

  // ── the plate ──
  const plate = plateOrFallback(spec.plate, !!img)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, PLATE, PLATE)
  ctx.clip()
  if (plate.kind === 'image' && img) {
    const r = pic?.rect
    ctx.imageSmoothingQuality = 'high' // the cut is downsampled a little (645 → 630 px for Sentinel-2)
    if (r) ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, PLATE, PLATE)
    else ctx.drawImage(img, 0, 0, PLATE, PLATE)
    if (plate.clouded) {
      ctx.fillStyle = C.veil
      ctx.fillRect(0, 0, PLATE, PLATE)
      drawPrims(ctx, [{ t: 'path', d: hatchPath(PLATE), stroke: C.hatch, width: 1 }])
    }
    drawPrims(ctx, plate.overlay)
    drawChip(ctx, plate.chip)
    drawScale(ctx, plate.scale)
    if (plate.clouded) drawChip(ctx, plate.clouded)
    drawChip(ctx, plate.credit)
  } else if (plate.kind === 'plan') drawPlan(ctx, plate)
  ctx.restore()
  ctx.fillStyle = C.lineStrong
  ctx.fillRect(PLATE, 0, 1, CARD_H)

  // ── the panel ──
  const X = PANEL.x
  const R = PANEL.right
  rowText(ctx, 'Overflight', X, PANEL.top, C.bone, monoFace(CARD_FS.lockup, CARD_FS.lockup * TRACK.lockup, 500))
  if (spec.stamp) rowText(ctx, spec.stamp, R, PANEL.top, C.bone2, monoFace(CARD_FS.row), 'right')
  ctx.fillStyle = C.line
  ctx.fillRect(X, PANEL.rule1, PANEL.w, 1)

  // verdict row: glyph + verdict name, coordinates right
  ctx.save()
  ctx.translate(X, PANEL.verdict[0] + (PANEL.verdict[1] - 14) / 2)
  drawPrims(ctx, verdictGlyphPrims(spec.verdict))
  ctx.restore()
  rowText(ctx, spec.verdictLabel, X + 14 + 10, PANEL.verdict, TONE_COLOR[spec.verdictTone], monoFace(CARD_FS.row))
  rowText(ctx, spec.coords, R, PANEL.verdict, C.bone3, monoFace(CARD_FS.row), 'right')

  // headline, bottom-aligned: condensed lead lines, serif place, optional sub-line
  const S = spec.size
  const P = S * HEAD.placeScale
  const lead: Face = { family: SANS, size: S, weight: 560, stretch: 'condensed', tracking: -0.02 * S }
  const place: Face = { family: SERIF, size: P, italic: true, tracking: -0.01 * P }
  const sub: Face = { family: SANS, size: CARD_FS.sub }
  setFace(ctx, lead)
  const leadLines = wrap(ctx, spec.lead, PANEL.w, lead.tracking!)
  setFace(ctx, place)
  const placeLines = wrap(ctx, `${spec.place}${spec.tail}`, PANEL.w, place.tracking!)
  setFace(ctx, sub)
  const subLines = spec.sub ? wrap(ctx, spec.sub, PANEL.w, 0) : []
  const leadLH = S * HEAD.leadLH
  const placeLH = P * HEAD.placeLH
  const subLH = CARD_FS.sub * HEAD.subLH
  const total = leadLines.length * leadLH + P * HEAD.placeGap + placeLines.length * placeLH + (subLines.length ? HEAD.subGap + subLines.length * subLH : 0)
  let y = PANEL.headBottom - total
  ctx.fillStyle = C.bone
  setFace(ctx, lead)
  for (const l of leadLines) {
    fillText(ctx, l, X, baselineIn(ctx, y, leadLH), lead.tracking!)
    y += leadLH
  }
  y += P * HEAD.placeGap
  setFace(ctx, place)
  for (const l of placeLines) {
    fillText(ctx, l, X, baselineIn(ctx, y, placeLH), place.tracking!)
    y += placeLH
  }
  if (subLines.length) {
    y += HEAD.subGap
    setFace(ctx, sub)
    ctx.fillStyle = C.bone2
    for (const l of subLines) {
      fillText(ctx, l, X, baselineIn(ctx, y, subLH), 0)
      y += subLH
    }
  }

  // readouts
  ctx.fillStyle = C.line
  ctx.fillRect(X, PANEL.rule2, PANEL.w, 1)
  const colW = PANEL.w / spec.readouts.length
  spec.readouts.forEach((r, i) => {
    const cx = X + i * colW + (i ? 22 : 0)
    if (i) {
      ctx.fillStyle = C.line
      ctx.fillRect(X + i * colW, PANEL.roLabel[0], 1, PANEL.roValue[0] + PANEL.roValue[1] - PANEL.roLabel[0])
    }
    rowText(ctx, r.label, cx, PANEL.roLabel, C.bone3, monoFace(CARD_FS.row))
    const size = spec.readoutSize ?? CARD_FS.readout
    const vf = monoFace(size, TRACK.readout * size)
    setFace(ctx, vf)
    const base = baselineIn(ctx, PANEL.roValue[0], size)
    ctx.fillStyle = C.bone
    fillText(ctx, r.value, cx, base, vf.tracking!)
    const vw = textWidth(ctx, r.value, vf.tracking!)
    if (r.unit) {
      const uf = monoFace(CARD_FS.readoutUnit)
      setFace(ctx, uf)
      ctx.fillStyle = C.bone3
      fillText(ctx, r.unit.toUpperCase(), cx + vw + 8, base, uf.tracking!)
    }
  })

  // footer
  ctx.fillStyle = C.line
  ctx.fillRect(X, PANEL.rule3, PANEL.w, 1)
  rowText(ctx, spec.footLeft, X, PANEL.foot, C.bone2, monoFace(CARD_FS.row))
  if (spec.host) {
    setFace(ctx, monoFace(CARD_FS.row, 0.5))
    const w = textWidth(ctx, spec.host, 0.5)
    ctx.fillStyle = C.bone2
    fillText(ctx, spec.host, R - w, baselineIn(ctx, PANEL.foot[0], PANEL.foot[1]), 0.5)
  }

  return new Promise<Blob>((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'))
}
