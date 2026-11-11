/**
 * The share card in the browser: its spec (from the shared builder in api/_lib/cardSpec.ts, so the
 * preview, this PNG and the server's Open Graph card print identical fields) and the PNG renderer.
 *
 * 1200 × 630 (OG size). Left: the real crop, centred on the ROUNDED place (privacy), with the reticle,
 * source chip, scale bar and the archive's credit; or the pass geometry when there is no picture.
 * Right: wordmark + local time, headline ("7 satellites watched Waterloo."), three readouts, the invitation footer.
 *
 * The plate (share R2SH1): the pass view has already decoded a larger crop of the same scene around the
 * searched point (1024 px, ±5 km for Sentinel-2). The card's square, centred on the rounded share point,
 * lies inside it, so `cardSource` maps that square into the decoded picture's pixels and the preview and
 * the PNG cut it out: no second render from the archive, no "Acquiring" plate, a PNG ready in well under
 * a second. Only that rect is ever drawn (the DOM preview clips to it too), so the card shows exactly the
 * ground a fresh crop centred on the rounded point would show. When the pass view's picture isn't in
 * the cache (a summary's closest look, a recipient's first look), the same rect is loaded and faded in.
 * Pictures go through the results' session photo cache (loadPhoto): one request per URL for the page.
 */
import { geoCaptureFromItem, gibsWmsUrl, pcCropUrl, radarCropUrl, radarPolOfItemId } from '@/imagery'
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
  type CardCrop,
  type CardSpec,
  type Chip,
  type PlanPlate,
  type PlateSource,
  type Prim,
  type ScaleBar,
  type SummaryLook,
} from '../../../api/_lib/cardSpec'
import { cropCrs, gridOfBox, isToneCollection, nativeBox } from '../../../api/_lib/toneRender'
import { loadPhoto } from '../results/images'
import { coverPinKey, pinnedOrder } from '../results/gallery'
import { orderPhotos } from '../results/lib/photos'
import { platformDisplayName } from '@/lib/backend'
import { captureFor, cropSpec, displayUrl } from '../results/lib/captures'
import { archiveDown, headline } from '../results/lib/copy'
import type { MetaFn, SatMeta } from '../results/lib/meta'
import { roundedPlace, type SummaryLinkInput } from './links'
import { WORDMARK_BOX, WORDMARK_DOT, WORDMARK_PATH } from '../../../api/_lib/wordmark'

/** Lockup height on the 1200×630 card (fills the 22 px header row). */
const LOCKUP_H = 22

export { CARD_H, CARD_W, PLATE, type CardSpec, type PlateSource }

export interface CardOptions {
  /** The picture is mostly cloud (results' isClouded): the clouded variant. */
  clouded?: boolean
}

/** N for a pass card's headline (owner): the results headline's count of satellites that watched the place this week. */
export function weekSatellites(report: Report, meta: MetaFn): number {
  return headline(report, meta).flewOver
}

/**
 * Crop URL for a capture at the card's scale, centred on an arbitrary point (the rounded share point): on the
 * place's grid (the server's card builds the very same URL, api/_lib/imagery.ts cropPlan).
 */
export function cropUrlFor(capture: Pick<Capture, 'provider' | 'collection' | 'itemId' | 'cropUrl'>, crop: CardCrop, lat: number, lon: number): string | undefined {
  const opts = { halfSizeKm: crop.halfSizeKm, px: PLATE }
  if (capture.provider === 'planetary-computer' && (capture.collection === 'sentinel-2-l2a' || capture.collection === 'landsat-c2-l2')) {
    // Planetary Computer renders the same crop as JPEG at a fraction of the PNG's size.
    return pcCropUrl(capture.collection, capture.itemId, { lat, lon }, opts).replace(/\.png\?/, '.jpg?')
  }
  if (capture.collection === 'sentinel-1-rtc') {
    // A radar image: the server's card asks for this very crop (api/_lib/imagery.ts cropPlan).
    const pol = radarPolOfItemId(capture.itemId)
    return pol ? radarCropUrl(capture.itemId, pol, { lat, lon }, opts).replace(/\.png\?/, '.jpg?') : undefined
  }
  // A geostationary frame, from NASA GIBS or EUMETSAT: the layer and the time are its item id.
  const geo = geoCaptureFromItem(capture.collection, capture.itemId, { lat, lon })
  if (geo) return geo.cropUrl(opts)
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
const PC_BOX = /^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\/(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\//

/**
 * Where the card's square sits inside the picture the pass view decoded (share R2SH1).
 *
 * The pass view shows displayUrl(capture, cropSpec(collection)): a `spec.px` square, linear in its own coordinates.
 * On the place's UTM grid (every Sentinel-2 / Landsat photo below 84° N) that is grid metres: the photo is the box of whole
 * native pixels around the exact point (toneRender nativeBox) and the card's square the box of whole native pixels
 * around the rounded point on the same grid, so the card is cut at whole-pixel offsets (Sentinel-2: 630 of the
 * photo's own 1000 pixels, the very pixels the server's card copies). Otherwise lon/lat (EPSG:4326):
 * bboxAround(exact, spec.halfSizeKm) and bboxAround(rounded, crop.halfSizeKm). Undefined when the card's box leaves
 * the source on any side, or when the capture has no such crop (an Earth Search thumbnail).
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
  const crs = cropCrs(url)
  let D: [number, number, number, number]
  let Cb: [number, number, number, number]
  if (crs !== null && crs !== 4326 && isToneCollection(capture.collection)) {
    const m = PC_BOX.exec(url)!
    D = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    const grid = gridOfBox(capture.collection, crs, D)
    Cb = nativeBox(grid, rounded.lat, rounded.lon, Math.round((2 * crop.halfSizeKm * 1000) / grid.gsd))
  } else {
    D = bboxAround(exact.lat, exact.lon, spec.halfSizeKm)
    Cb = bboxAround(rounded.lat, rounded.lon, crop.halfSizeKm)
  }
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
export function cardSpec(pass: Pass, report: Report, meta: SatMeta, timeZone: string, host: string, opts: CardOptions & { satellites?: number } = {}): CardSpec {
  const r = roundedPlace(report.place.lat, report.place.lon)
  const capture = captureFor(report, pass)
  const spec = buildCardSpec({
    verdict: pass.verdict,
    satName: meta.name,
    placeLabel: report.place.label,
    satellites: opts.satellites,
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
 * The week at a place (share SH6, R3-13), in the results headline's numbers: N, the distinct satellites that
 * watched it (any pass; geostationary watchers excluded), and K, the images made public (the imaged passes'
 * captures, weather mosaics and radar included). Plus the four verdict counts and the picture: the results gallery's
 * FIRST image (owner), as the gallery shows it (its pinned cover) and labelled as the gallery tags it: the closest
 * clear look, or the last clear look from before a cloudy week, or the least cloudy one, or a radar image.
 */
export function summaryFacts(report: Report, placeLabel: string, meta: MetaFn): SummaryLinkInput & { best?: SummaryLinkInput['best'] & { capture: Capture } } {
  const counts = { imaged: 0, likely: 0, could: 0, overhead: 0 }
  for (const p of report.passes) if (!p.geostationary) counts[p.verdict]++
  const head = headline(report, meta)
  const set = orderPhotos(report)
  const first = pinnedOrder(set.photos, coverPinKey(report))[0]
  const look: SummaryLook | undefined = !first
    ? undefined
    : set.cover?.photo.key === first.key
      ? set.cover.why
      : first.kind === 'radar'
        ? 'radar'
        : 'plain'
  const norad = first ? (first.pass?.norad ?? first.capture.norad) : undefined
  const best =
    first && look
      ? {
          collection: first.capture.collection,
          itemId: first.capture.itemId,
          satName: norad !== undefined ? meta(norad).name : (platformDisplayName(first.capture.platform) ?? 'A satellite'),
          tClosest: first.pass?.tClosest ?? first.capture.datetime,
          gsdM: first.capture.gsdM,
          capture: first.capture,
          look,
        }
      : undefined
  const down = archiveDown(report)
  return {
    label: placeLabel,
    lat: report.place.lat,
    lon: report.place.lon,
    satellites: head.flewOver,
    // K is the headline's own count (it equals the imaged passes, the card's PHOTO readout).
    counts: { ...counts, imaged: head.images },
    archiveDown: down || undefined,
    partial: !down && (report.partial || (report.lateChecks ?? 0) > 0) ? true : undefined,
    windowEnd: report.windowEnd,
    best,
  }
}

/** The summary card, as the sharer sees it (the server builds the same from the link's parameters). */
export function summaryCardSpec(report: Report, placeLabel: string, meta: MetaFn, timeZone: string, host: string): CardSpec {
  const f = summaryFacts(report, placeLabel, meta)
  const r = roundedPlace(report.place.lat, report.place.lon)
  const c = f.best?.capture
  const spec = buildSummarySpec({
    placeLabel,
    lat: r.lat,
    lon: r.lon,
    satellites: f.satellites,
    counts: f.counts,
    archiveDown: f.archiveDown,
    partial: f.partial,
    windowEnd: f.windowEnd,
    timeZone,
    best: f.best && c ? { satName: f.best.satName, tClosest: f.best.tClosest, capture: { collection: c.collection, itemId: c.itemId, gsdM: c.gsdM }, look: f.best.look } : undefined,
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
/** The serif wordmark, height h with its top-left at (x, y): letters in bone, the full stop in signal. */
function drawWordmark(ctx: Ctx, x: number, y: number, h: number) {
  const [bx, by, , bh] = WORDMARK_BOX
  const k = h / bh
  ctx.save()
  ctx.translate(x - bx * k, y - by * k)
  ctx.scale(k, k)
  ctx.fillStyle = C.bone
  ctx.fill(new Path2D(WORDMARK_PATH))
  ctx.fillStyle = C.signal
  ctx.beginPath()
  ctx.arc(WORDMARK_DOT.cx, WORDMARK_DOT.cy, WORDMARK_DOT.r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function rowText(ctx: Ctx, text: string, x: number, box: readonly [number, number], color: string, face: Face, align: 'left' | 'right' = 'left') {
  setFace(ctx, face)
  const t = text.toUpperCase()
  const w = textWidth(ctx, t, face.tracking ?? 0)
  ctx.fillStyle = color
  fillText(ctx, t, align === 'left' ? x : x - w, baselineIn(ctx, box[0], box[1]), face.tracking ?? 0)
  return w
}

/**
 * The picture for the plate: the pass view's decoded crop when there is one (a hit in the results' session
 * photo cache, so no request and no decode), else the card's own crop.
 */
async function plateImage(spec: CardSpec): Promise<{ img: HTMLImageElement; rect?: PlateSource } | null> {
  if (spec.plate.kind !== 'image') return null
  const { source, imageUrl } = spec.plate
  if (source) {
    const img = await loadPhoto(source.url).catch(() => null)
    if (img) return { img, rect: source }
  }
  const img = imageUrl ? await loadPhoto(imageUrl).catch(() => null) : null
  return img ? { img } : null
}

/**
 * Render the card to a PNG blob on a canvas (fonts are the page's own web fonts; the crop is CORS-clean
 * because every archive sends `Access-Control-Allow-Origin: *` and loadPhoto asks anonymously).
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
    ctx.imageSmoothingQuality = 'high' // a cut on the place's grid is copied 1:1 (630 of the photo's own pixels); a lon/lat cut is resampled a little
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
  drawWordmark(ctx, X, PANEL.top[0] + (PANEL.top[1] - LOCKUP_H) / 2, LOCKUP_H)
  if (spec.stamp) rowText(ctx, spec.stamp, R, PANEL.top, C.bone2, monoFace(CARD_FS.row), 'right')
  ctx.fillStyle = C.line
  ctx.fillRect(X, PANEL.rule1, PANEL.w, 1)

  // headline, centred in its band (PANEL.headTop … headBottom): condensed lead lines, serif place, optional sub-line
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
  let y = PANEL.headTop + (PANEL.headBottom - PANEL.headTop - total) / 2
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
