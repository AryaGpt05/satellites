/**
 * The share card, specified once (share SH2). Three renderers draw exactly these fields:
 *
 *   src/ui/share/ShareCard.tsx   the DOM preview in the share sheet
 *   src/ui/share/card.ts         the PNG people save, attach to a native share or paste (canvas)
 *   api/_lib/card.ts             the Open Graph card X / iMessage / Slack unfurl (satori)
 *
 * Every string, number, colour and position on the card comes from here, so the sharer previews
 * the card their followers will see. Pure TypeScript with no DOM or Node APIs: the browser app
 * imports it by relative path, the serverless functions import it directly.
 *
 *   ┌──────────── 630 ────────────┬──────────────── 570 ───────────────┐
 *   │ SENTINEL-2C · MSI · 10 M  ├1 KM┤│ Watched.      SUN 1 NOV 2026 · 11:21 EST│
 *   │                             │ ─────────────────────────────────── │
 *   │                             │                                     │
 *   │            ⊕                │ 7 satellites                        │
 *   │   real crop (or geometry)   │ watched                             │
 *   │                             │ Waterloo.                           │
 *   │                             │ ─────────────────────────────────── │
 *   │                             │ ALTITUDE    OFF-NADIR     PIXEL      │
 *   │ CONTAINS MODIFIED COPERNICUS│ 795 KM      5.3°          10 M       │
 *   │                             │ SEE WHAT WATCHED YOU  www.watched.earth│
 *   └─────────────────────────────┴─────────────────────────────────────┘
 *
 * Text is stored in sentence case; mono rows are uppercased by the renderers (as CSS does).
 */

export type Verdict = 'imaged' | 'likely' | 'could' | 'overhead'

export const CARD_W = 1200
export const CARD_H = 630
/** The left square: the picture (or the pass geometry). */
export const PLATE = 630

/** Mirrors src/styles/tokens.css (satori and canvas have no CSS variables). */
export const CARD_COLOR = {
  ink0: '#07080A',
  ink1: '#0C0E11',
  bone: '#ECE8E0',
  bone2: 'rgba(236,232,224,0.64)',
  bone3: 'rgba(236,232,224,0.52)',
  bone3Mark: 'rgba(236,232,224,0.40)',
  bone4: 'rgba(236,232,224,0.18)',
  line: 'rgba(236,232,224,0.10)',
  lineStrong: 'rgba(236,232,224,0.22)',
  signal: '#FF6A1A',
  warn: '#E8C547',
  /** Flat ink chip behind text on imagery (no blur, no shadow: DESIGN §1). */
  chip: 'rgba(7,8,10,0.78)',
  /** Clouded picture: an ink veil ≈ brightness(.55), identical in every renderer (satori has no filter). */
  veil: 'rgba(7,8,10,0.45)',
  hatch: 'rgba(236,232,224,0.14)',
} as const

export type Tone = 'bone' | 'bone2' | 'bone3' | 'signal' | 'warn'

/** Type sizes on the card (px at 1200 × 630). */
export const CARD_FS = {
  /** In-image credit line (the renderers' micro size) */
  micro: 12,
  /** Chips over the picture */
  chip: 13,
  /** The main picture chip (satellite · sensor · pixel) */
  chipLead: 14,
  /** Mono rows of the panel: stamp, readout labels, footer */
  row: 13,
  lockup: 16,
  readout: 30,
  readoutUnit: 14,
  sub: 24,
} as const

/** Letter-spacing in em: mono labels +0.08em, the wordmark +0.26em (as the HUD's). */
export const TRACK = { label: 0.08, lockup: 0.26, readout: -0.01 } as const

/**
 * The right panel's fixed rows (card px). Boxes are [top, height]; text is centred in its box.
 * The headline block is centred in [headTop, headBottom]: the band between the top rule and the readouts' rule,
 * lifted HEAD_LIFT so the block reads as centred (its line boxes carry more empty room below, under the serif
 * place, than above the condensed caps).
 */
export const PANEL = {
  x: PLATE + 52,
  right: CARD_W - 52,
  w: CARD_W - PLATE - 104,
  top: [42, 22] as const,
  rule1: 82,
  /** rule1 + 1 … rule2 − 2·HEAD_LIFT: the headline block is centred in this band (no row above it: owner) */
  headTop: 83,
  headBottom: 454,
  rule2: 466,
  roLabel: [486, 16] as const,
  roValue: [512, 32] as const,
  rule3: 566,
  foot: [582, 20] as const,
} as const

/** Lead line height, place line height and gap (in em of their own font sizes): .place { line-height: .9; margin-top: .1em } */
export const HEAD = { leadLH: 0.94, placeScale: 1.06, placeLH: 0.9, placeGap: 0.1, subGap: 16, subLH: 1.3 } as const

// ── Spec ────────────────────────────────────────────────────────────────────────────────────

export interface Readout {
  label: string
  value: string
  unit?: string
}

export interface ChipSeg {
  text: string
  tone: Tone
}
export interface Chip {
  segs: ChipSeg[]
  size: number
  pos: { left?: number; right?: number; top?: number; bottom?: number }
}

export interface ScaleBar {
  /** bar length, px */
  px: number
  /** "1 KM", "500 M" */
  label: string
}

/** A vector primitive in plate coordinates (0…PLATE). Paths are SVG path data (canvas reads them via Path2D). */
export type Prim =
  | {
      t: 'path'
      d: string
      stroke?: string
      width?: number
      fill?: string
      dash?: [number, number]
      /** Stroke with a linear gradient instead of `stroke` (user-space coordinates). */
      grad?: { x1: number; y1: number; x2: number; y2: number; from: string; to: string }
    }
  | { t: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string; width?: number }

/**
 * Client only (share R2SH1): the card's square cut out of a larger picture the app has already
 * decoded (the pass view's crop), in that picture's pixels. The rect is the card crop centred on the
 * ROUNDED share point; nothing outside it is ever drawn. The server never reads this.
 */
export interface PlateSource {
  /** The decoded picture (the pass view's display URL) */
  url: string
  /** The card's square inside it, source pixels: left, top, width, height */
  sx: number
  sy: number
  sw: number
  sh: number
  /** The source picture's side, px */
  px: number
}

export interface ImagePlate {
  kind: 'image'
  /** The crop to draw (centred on the rounded share point). */
  crop: CardCrop
  /** Filled in by each side (client: imagery endpoints; server: cropPlan). */
  imageUrl?: string
  /** Client only: the same square cut from the picture already on screen (see PlateSource). */
  source?: PlateSource
  chip: Chip
  credit: Chip
  scale: ScaleBar
  /** Clouded picture: veil + hatch + this warn chip. */
  clouded?: Chip
  /** Drawn over the picture (under the chips): free-corner ticks and the place reticle. */
  overlay: Prim[]
  /** Drawn instead when the picture can't be fetched. */
  fallback: PlanPlate
}

export interface PlanPlate {
  kind: 'plan'
  prims: Prim[]
  chips: Chip[]
  scale: ScaleBar
}

export type Plate = ImagePlate | PlanPlate

export interface CardSpec {
  verdict: Verdict
  /** Top right: "Sun 1 Nov 2026 · 11:21 EST" ("" when unknown) */
  stamp: string
  /** "7 satellites watched" (owner: every card leads with the week's N; the satellite's own name when N is unknown) */
  lead: string
  place: string
  /** "." after the place (" this week." on the summary card), or "" when the place was cut short with an ellipsis */
  tail: string
  /** Clouded: cloudWords().sub, e.g. "Mostly cloud: 81% of the scene." */
  sub?: string
  /** Headline font size, px */
  size: number
  readouts: Readout[]
  /** Readout value size, px (default CARD_FS.readout; four columns use a smaller one) */
  readoutSize?: number
  /** Footer left: the invitation back */
  footLeft: string
  /** Footer right: "www.watched.earth" ("" hides it) */
  host: string
  plate: Plate
}

export interface CardCaptureInput {
  collection: string
  itemId?: string
  provider?: string
  platform?: string
  gsdM?: number
  cloudCoverPct?: number
  /** The pixel at the place (results' spot classification), when known: 'cloud' means clouded there. */
  spot?: 'clear' | 'cirrus' | 'cloud' | 'shadow' | 'unknown'
  datetime?: number
}

export interface CardInput {
  verdict: Verdict
  satName: string
  placeLabel: string
  /**
   * N: the satellites that watched the place that week (the results headline's number). The card then reads
   * "7 satellites watched Waterloo." (owner); a share stored before N was kept falls back to "Sentinel-2C watched Waterloo."
   */
  satellites?: number
  /** The rounded share point (2 decimals) */
  lat: number
  lon: number
  tClosest?: number
  /** IANA zone at the place; UTC when unknown */
  timeZone?: string
  pass: {
    altitudeKm?: number
    offNadirDeg?: number
    elevationDeg?: number
    groundSpeedKmS?: number
    groundDistanceKm?: number
    azimuthDeg?: number
    headingDeg?: number
  }
  capture?: CardCaptureInput
  /** The picture is mostly cloud (results: spot cloud or ≥ 70 % of the scene) */
  clouded?: boolean
  /** Imaged, but this capture can't be cropped by the card renderer ('permanent') */
  imageMiss?: 'transient' | 'permanent'
  host: string
}

/**
 * The one verdict vocabulary (docs/DESIGN.md §7; mirrors src/ui/results/lib/meta.ts, kept equal by a test).
 * Owner override (latest): user-facing copy says "watched", never "photographed".
 */
export const VERDICT_WORDS: Record<Verdict, { title: string; verb: string }> = {
  imaged: { title: 'Watched', verb: 'watched' },
  likely: { title: 'Likely watched', verb: 'swept over' },
  could: { title: 'Could have pointed here', verb: 'passed within view of' },
  overhead: { title: 'Passed overhead', verb: 'passed over' },
}

export const FOOT_LEFT = 'See what watched you'
/** og:image:alt for the default (root link) card: index.html uses the same words (core K9). */
export const DEFAULT_CARD_ALT =
  'A real Sentinel-2 satellite photograph of Palm Jumeirah, Dubai, beside the line: Something watched you this week. Enter any place on Earth.'
/** The card's sub-line when the scene is ≥ OVERCAST_PCT cloud (cloudWords' strongest case). */
export const CLOUDED_LINE = 'Clouded over. It saw only cloud.'
/** Scene cloud cover at or above which the card calls the picture clouded (as results' isClouded). */
export const CLOUDED_PCT = 70
/** Scene cloud cover at or above which "it saw only cloud" is true (as PassDetail's overcast line). */
export const OVERCAST_PCT = 90

/** The spot classes a capture can carry (results' SpotCloud). */
export type SpotCloudLike = 'clear' | 'cirrus' | 'cloud' | 'shadow' | 'unknown'

export interface CloudWords {
  /** The card's sub-line under the headline */
  sub: string
  /** The warn chip over the picture */
  chip: string
  /** Appended to the post text after "…from 795 km up on Sun 1 Nov at 11:21 local." */
  post: string
  /** The og:description sentence */
  desc: string
}

/**
 * One rule for clouded words (share R2SH3), so the card, the PNG, /api/og, the share page and the post
 * say what the picture shows: only cloud (≥ 90 %), mostly cloud (70–89 %), or cloud over the spot itself
 * (the place's pixel is cloud while the scene is clearer). Undefined when the picture isn't clouded.
 */
export function cloudWords(pct?: number, spot?: SpotCloudLike | string): CloudWords | undefined {
  const known = pct !== undefined && Number.isFinite(pct)
  const p = known ? Math.round(pct) : 0
  if (known && pct >= OVERCAST_PCT) {
    return { sub: CLOUDED_LINE, chip: `Clouded over · ${p}%`, post: 'It saw only cloud.', desc: `It saw only cloud (${p}%).` }
  }
  if (known && pct >= CLOUDED_PCT) {
    return { sub: `Mostly cloud: ${p}% of the scene.`, chip: `Mostly cloud · ${p}%`, post: `It saw mostly cloud (${p}%).`, desc: `It saw mostly cloud (${p}%).` }
  }
  if (spot === 'cloud') {
    return { sub: 'Cloud over the spot itself.', chip: 'Cloud over the spot', post: 'Cloud covered the spot.', desc: 'Cloud covered the spot.' }
  }
  return undefined
}

const PLACE_MAX = 48

export function headlineParts(verdict: Verdict, satName: string, placeLabel: string): { lead: string; place: string; tail: string } {
  const cps = Array.from(placeLabel)
  const place = cps.length > PLACE_MAX ? `${cps.slice(0, PLACE_MAX - 1).join('').trimEnd()}…` : placeLabel
  // "…." reads as a typo: a place already cut short ends on the ellipsis alone.
  return { lead: `${satName} ${VERDICT_WORDS[verdict].verb}`, place, tail: place.endsWith('…') ? '' : '.' }
}

/**
 * A pass card's headline (owner): the week's N, "7 satellites watched | Waterloo | .", the same words as the results
 * headline; the satellite's own sentence ("Sentinel-2C watched | Waterloo | .") only when N isn't known (older shares).
 */
export function passHeadlineParts(i: Pick<CardInput, 'verdict' | 'satName' | 'placeLabel' | 'satellites'>): { lead: string; place: string; tail: string } {
  const h = headlineParts(i.verdict, i.satName, i.placeLabel)
  const n = i.satellites
  return n !== undefined && Number.isFinite(n) && n >= 1 ? { ...h, lead: watchedLead(n) } : h
}

/**
 * Headline size so the lead wraps to at most three condensed lines and the serif place to at most
 * two in the 466px column: the smaller of what the lead and the place each allow.
 */
export function headlineSize(lead: string, place: string): number {
  const n = lead.length
  const p = Array.from(place).length
  const byLead = n <= 24 ? 84 : n <= 32 ? 72 : n <= 42 ? 62 : 54
  const byPlace = p <= 13 ? 84 : p <= 18 ? 72 : p <= 26 ? 62 : 54
  return Math.min(byLead, byPlace)
}

// ── Numbers and places ──────────────────────────────────────────────────────────────────────

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const int = (n: number) => nf0.format(Math.round(n))
const fixed = (n: number, d: number) => n.toFixed(d)

export function fmtCoords(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`
}

/** "Nice" round length ≤ max: 1, 2, 5 × 10ⁿ. */
export function niceLength(max: number): number {
  const p = 10 ** Math.floor(Math.log10(max))
  for (const m of [5, 2, 1]) if (m * p <= max) return m * p
  return p
}

/** "1 KM" / "500 M" */
export function fmtKm(km: number): string {
  return km >= 1 ? `${km} km` : `${Math.round(km * 1000)} m`
}

// ── Time at the place ───────────────────────────────────────────────────────────────────────
// A port of src/ui/results/lib/time.ts (localParts / zoneAbbr), so the server prints exactly what
// the app prints. A test compares the two.

const fmts = new Map<string, Intl.DateTimeFormat>()
function dtf(site: string, locale: string, timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${site}|${timeZone}`
  let f = fmts.get(key)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...opts, timeZone })
    } catch {
      f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' })
    }
    fmts.set(key, f)
  }
  return f
}
const PARTS_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface Parts {
  year: number
  month: number
  day: number
  weekday: string
  hour: number
  minute: number
  second: number
}
function parts(ms: number, timeZone: string): Parts {
  const ps = dtf('parts', 'en-GB', timeZone, PARTS_OPTS).formatToParts(ms)
  const get = (t: Intl.DateTimeFormatPartTypes) => ps.find((p) => p.type === t)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday').slice(0, 3),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
  }
}

function utcOffsetMin(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000)
}

function utcLabel(offsetMin: number): string {
  if (!offsetMin) return 'UTC'
  const a = Math.abs(offsetMin)
  const h = Math.floor(a / 60)
  const m = a % 60
  return `UTC${offsetMin < 0 ? '−' : '+'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`
}

const FIXED_ABBR: Record<string, string> = {
  'Asia/Tokyo': 'JST',
  'Asia/Seoul': 'KST',
  'Asia/Kolkata': 'IST',
  'Asia/Calcutta': 'IST',
  'Asia/Hong_Kong': 'HKT',
  'Asia/Singapore': 'SGT',
  'Asia/Jakarta': 'WIB',
  'Europe/Moscow': 'MSK',
  'Australia/Perth': 'AWST',
}
const EUROPE: Record<number, [string, string]> = { 0: ['WET', 'WEST'], 60: ['CET', 'CEST'], 120: ['EET', 'EEST'] }
const BRITISH = new Set(['Europe/London', 'Europe/Belfast', 'Europe/Guernsey', 'Europe/Isle_of_Man', 'Europe/Jersey'])
const AUSTRALIA: Record<number, [string, string]> = { 600: ['AEST', 'AEDT'], 570: ['ACST', 'ACDT'], 480: ['AWST', 'AWST'] }

function standardOffsetMin(ms: number, timeZone: string): number {
  const year = new Date(ms).getUTCFullYear()
  return Math.min(utcOffsetMin(Date.UTC(year, 0, 1), timeZone), utcOffsetMin(Date.UTC(year, 6, 1), timeZone))
}

/** "EST", "CET", "JST", "AEDT"… or "UTC+9" where there is no familiar abbreviation (DST-correct). */
export function zoneAbbr(ms: number, timeZone: string): string {
  const fixedName = FIXED_ABBR[timeZone]
  if (fixedName) return fixedName
  if (timeZone.startsWith('Europe/') || timeZone.startsWith('Australia/') || timeZone === 'Arctic/Longyearbyen') {
    const std = standardOffsetMin(ms, timeZone)
    const dst = utcOffsetMin(ms, timeZone) > std ? 1 : 0
    if (BRITISH.has(timeZone)) return dst ? 'BST' : 'GMT'
    if (timeZone === 'Europe/Dublin') return dst ? 'IST' : 'GMT'
    const pair = (timeZone.startsWith('Australia/') ? AUSTRALIA : EUROPE)[std]
    if (pair) return pair[dst]
    return utcLabel(utcOffsetMin(ms, timeZone))
  }
  const name = dtf('zone', 'en-US', timeZone, { timeZoneName: 'short' })
    .formatToParts(ms)
    .find((p) => p.type === 'timeZoneName')?.value
  if (!name || name === 'GMT' || name === 'UTC') return 'UTC'
  if (/^GMT[+-]/.test(name)) return utcLabel(utcOffsetMin(ms, timeZone))
  return name
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "Sun 1 Nov 2026 · 11:21 EST" at the place (the card is the one place a human date carries the year). */
export function localStamp(ms: number, timeZone = 'UTC'): string {
  const p = parts(ms, timeZone)
  return `${p.weekday} ${p.day} ${MONTHS[p.month - 1] ?? ''} ${p.year} · ${pad2(p.hour)}:${pad2(p.minute)} ${zoneAbbr(ms, timeZone)}`
}

// ── Imagery: crop, sensor, credit ───────────────────────────────────────────────────────────

const NATIVE_GSD_M: Record<string, number> = {
  'sentinel-2-l2a': 10,
  'landsat-c2-l2': 30,
  'gibs-viirs-noaa20': 375,
  'gibs-viirs-noaa21': 375,
  'gibs-viirs-snpp': 375,
  'gibs-modis-terra': 250,
  'gibs-modis-aqua': 250,
  'gibs-goes-east': 1000,
  'gibs-goes-west': 1000,
  'gibs-himawari': 1000,
}

export interface CardCrop {
  collection: string
  itemId?: string
  /** Half the side of the square on the ground, km */
  halfSizeKm: number
  /** Ground metres per card pixel */
  metresPerPx: number
}

/**
 * The card's crop: one output pixel = one native pixel (10 m for Sentinel-2 → a 6.3 km square: 630 of the scene's
 * own pixels, the very ones the app's photo shows), so the "10 M" on the chip is literally what each pixel is.
 * Landsat's 30 m is soft at 1:1 on a phone, so it renders at 15 m per pixel: an exact 2× of 315 native pixels
 * (9.45 km), as the app's Landsat photo is (500 native pixels at 1000 px), so the card shows the photo's pixels.
 */
export function cardCrop(c: Pick<CardCaptureInput, 'collection' | 'itemId' | 'gsdM'>, px = PLATE): CardCrop {
  const gsd = NATIVE_GSD_M[c.collection] ?? c.gsdM ?? 10
  const metresPerPx = c.collection === 'landsat-c2-l2' ? 15 : gsd
  return { collection: c.collection, itemId: c.itemId, halfSizeKm: Math.max(2, (metresPerPx * px) / 2000), metresPerPx }
}

export function sensorName(c: Pick<CardCaptureInput, 'collection' | 'platform'>): string {
  const k = c.collection
  if (k === 'sentinel-2-l2a') return 'MSI'
  if (k === 'landsat-c2-l2') return /9$/.test(c.platform ?? '') ? 'OLI-2' : 'OLI'
  if (k.startsWith('gibs-viirs')) return 'VIIRS'
  if (k.startsWith('gibs-modis')) return 'MODIS'
  if (k === 'gibs-himawari') return 'AHI'
  return 'ABI'
}

/** Attribution the archive asks for when its imagery is redistributed (the card is redistribution). */
export function creditFor(c: Pick<CardCaptureInput, 'collection' | 'datetime'>, fallbackMs?: number): string {
  if (c.collection === 'sentinel-2-l2a') {
    const t = c.datetime ?? fallbackMs
    return `Contains modified Copernicus Sentinel data ${t !== undefined ? new Date(t).getUTCFullYear() : new Date().getUTCFullYear()}`
  }
  if (c.collection === 'landsat-c2-l2') return 'Landsat: USGS / NASA'
  return 'NASA GIBS / EOSDIS'
}

function scaleFor(metresPerPx: number, maxPx = 150): ScaleBar {
  const km = niceLength((maxPx * metresPerPx) / 1000)
  return { px: Math.round((km * 1000) / metresPerPx), label: fmtKm(km) }
}

// ── Plate chips (positions shared by every renderer) ────────────────────────────────────────

const INSET = 24

function plateChip(text: string, pos: Chip['pos'], tone: Tone = 'bone', size: number = CARD_FS.chip): Chip {
  return { segs: [{ text, tone }], size, pos }
}

/** The place reticle: thin ring, four ticks, centre dot, in signal (DESIGN §6). Strokes ≥ 2px so it survives a 600px unfurl. */
export function reticlePrims(cx: number, cy: number, r = 26, width = 2): Prim[] {
  const t0 = r + 9
  const t1 = r + 25
  return [
    { t: 'circle', cx, cy, r, stroke: CARD_COLOR.signal, width },
    { t: 'path', d: `M${cx} ${cy - t0}V${cy - t1}M${cx} ${cy + t0}V${cy + t1}M${cx - t0} ${cy}H${cx - t1}M${cx + t0} ${cy}H${cx + t1}`, stroke: CARD_COLOR.signal, width },
    { t: 'circle', cx, cy, r: 3, fill: CARD_COLOR.signal },
  ]
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br'
const CORNERS: readonly Corner[] = ['tl', 'tr', 'bl', 'br']

/** L-shaped corner ticks inset into the square (all four corners unless `corners` names some). */
export function cornerTickPrim(size: number, inset: number, len: number, color: string, width = 2, corners: readonly Corner[] = CORNERS): Prim {
  const a = inset
  const b = size - inset
  const seg: Record<Corner, string> = {
    tl: `M${a} ${a + len}V${a}H${a + len}`,
    tr: `M${b - len} ${a}H${b}V${a + len}`,
    bl: `M${a} ${b - len}V${b}H${a + len}`,
    br: `M${b - len} ${b}H${b}V${b - len}`,
  }
  return { t: 'path', d: corners.map((c) => seg[c]).join(''), stroke: color, width }
}

/** The corner a chip is anchored in, or null for one placed inside the plate (callouts, distance labels). */
function cornerOf(pos: Chip['pos']): Corner | null {
  const near = (v?: number) => v !== undefined && v <= INSET * 3
  const h = near(pos.left) ? 'l' : near(pos.right) ? 'r' : null
  const v = near(pos.top) ? 't' : near(pos.bottom) ? 'b' : null
  return h && v ? (`${v}${h}` as Corner) : null
}

/**
 * The plate's viewfinder ticks, only in the corners no chip holds (the scale bar holds the top right),
 * with the outer edge of the 2px stroke on the chips' 24px inset: every corner element lines up, and no
 * tick ever peeks out around a chip.
 */
export function plateFrame(chips: readonly (Chip | undefined)[], scale: ScaleBar | undefined, color: string): Prim[] {
  const held = new Set<Corner>()
  for (const c of chips) {
    const k = c ? cornerOf(c.pos) : null
    if (k) held.add(k)
  }
  if (scale && scale.px > 0) held.add('tr')
  const free = CORNERS.filter((c) => !held.has(c))
  return free.length ? [cornerTickPrim(PLATE, INSET + 1, 16, color, 2, free)] : []
}

/** Ticks over a picture: bright enough to read on any terrain. */
const PICTURE_TICK = 'rgba(236,232,224,0.85)'

/** What is drawn over a picture: the free-corner ticks and the place reticle at the centre. */
export function imageOverlay(chips: readonly (Chip | undefined)[], scale: ScaleBar | undefined): Prim[] {
  return [...plateFrame(chips, scale, PICTURE_TICK), ...reticlePrims(PLATE / 2, PLATE / 2)]
}

/** Diagonal hatch over a clouded picture (as PassList's clouded thumbnail: 135°, 1px lines ≈ 5px apart). */
export function hatchPath(size: number, step = 7): string {
  let d = ''
  for (let k = 0; k < 2 * size; k += step) d += `M${k} 0L${k - size} ${size}`
  return d
}

/** The verdict mark (DESIGN §2): ◆ photographed, ◇ likely, □ could, ✛ overhead. */
export function verdictGlyphPrims(v: Verdict, s = 14): Prim[] {
  const m = s / 2
  const stroke = v === 'imaged' || v === 'likely' ? CARD_COLOR.signal : CARD_COLOR.bone
  if (v === 'imaged') return [{ t: 'path', d: `M${m} 0.5L${s - 0.5} ${m}L${m} ${s - 0.5}L0.5 ${m}Z`, fill: CARD_COLOR.signal }]
  if (v === 'likely') return [{ t: 'path', d: `M${m} 1.5L${s - 1.5} ${m}L${m} ${s - 1.5}L1.5 ${m}Z`, stroke, width: 1.5 }]
  if (v === 'could') return [{ t: 'path', d: `M2 2H${s - 2}V${s - 2}H2Z`, stroke, width: 1.5 }]
  return [{ t: 'path', d: `M${m} 1V${s - 1}M1 ${m}H${s - 1}`, stroke, width: 1.5 }]
}

// ── Plan plate: the pass to scale, north up ─────────────────────────────────────────────────

/**
 * No picture to show (commercial, crewed, not archived, or the archive was slow): draw the pass
 * itself, to scale. The place is the reticle at the centre; the ground track passes at the real
 * closest-approach distance and azimuth, in the real direction of travel. North is up.
 */
export function planPlate(input: Pick<CardInput, 'pass' | 'satName'>, note: string): PlanPlate {
  const S = PLATE
  const c = S / 2
  const p = input.pass
  const dist = p.groundDistanceKm
  const halfKm = niceLength(Math.max(30, (dist ?? 0) * 1.7) * 1.25) // keep the track well inside the frame
  const kmToPx = c / halfKm
  const prims: Prim[] = []
  const chips: Chip[] = []

  const step = S / 12
  let grid = ''
  for (let i = 1; i < 12; i++) grid += `M${i * step} 0V${S}M0 ${i * step}H${S}`
  prims.push({ t: 'path', d: grid, stroke: 'rgba(236,232,224,0.05)', width: 1 })
  prims.push({ t: 'path', d: `M${c} 0V${S}M0 ${c}H${S}`, stroke: 'rgba(236,232,224,0.09)', width: 1 })
  prims.push({ t: 'circle', cx: c, cy: c, r: c / 2, stroke: 'rgba(236,232,224,0.08)', width: 1 })

  const hdg = p.headingDeg
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
    const r1 = (v: number) => Math.round(v * 10) / 10
    // Trail behind the satellite (alpha fading along it, as on the globe), the path ahead dashed and dim.
    prims.push({
      t: 'path',
      d: `M${r1(px - dx * L)} ${r1(py - dy * L)}L${r1(px)} ${r1(py)}`,
      width: 2,
      grad: { x1: r1(px - dx * S * 0.7), y1: r1(py - dy * S * 0.7), x2: r1(px), y2: r1(py), from: 'rgba(236,232,224,0)', to: 'rgba(236,232,224,0.95)' },
    })
    prims.push({ t: 'path', d: `M${r1(px + dx * 34)} ${r1(py + dy * 34)}L${r1(px + dx * L)} ${r1(py + dy * L)}`, stroke: 'rgba(236,232,224,0.32)', width: 1.5, dash: [2, 6] })
    const tx = px + dx * 26
    const ty = py + dy * 26
    prims.push({
      t: 'path',
      d: `M${r1(tx - dx * 8 + nx * 6)} ${r1(ty - dy * 8 + ny * 6)}L${r1(tx)} ${r1(ty)}L${r1(tx - dx * 8 - nx * 6)} ${r1(ty - dy * 8 - ny * 6)}`,
      stroke: CARD_COLOR.bone,
      width: 2,
    })
    // Closest-approach perpendicular, labelled at its midpoint.
    if (g > 60) {
      prims.push({ t: 'path', d: `M${c} ${c}L${r1(px)} ${r1(py)}`, stroke: 'rgba(236,232,224,0.55)', width: 1, dash: [3, 4] })
      const mx = (c + px) / 2
      const my = (c + py) / 2
      const side = dx * (px - c) + dy * (py - c) >= 0 ? 1 : -1 // keep the label off the track
      const lx = mx - dx * 16 * side
      const ly = my - dy * 16 * side
      chips.push(plateChip(`${int(dist ?? 0)} km`, lx >= c ? { left: r1(lx), top: r1(ly - 14) } : { right: r1(S - lx), top: r1(ly - 14) }))
    }
    // The satellite at closest approach and its callout (leader line + chip).
    prims.push({ t: 'circle', cx: r1(px), cy: r1(py), r: 6, fill: CARD_COLOR.ink1, stroke: CARD_COLOR.bone, width: 2 })
    const alt = p.altitudeKm !== undefined ? `${int(p.altitudeKm)} km` : null
    const name = input.satName
    // Mono 13px with +0.08em tracking ≈ 9.2 px per glyph, plus chip padding and gap.
    const calloutW = (name.length + (alt ? alt.length : 0)) * 9.2 + 34
    const away = px >= c ? 1 : -1
    const fits = (sd: number) => (sd > 0 ? S - 16 - (px + 24 + 12) : px - 24 - 12 - 16) >= calloutW
    const side = fits(away) ? away : -away
    const ax = px + side * 24
    const ay = Math.max(76, Math.min(S - 136, py + (py >= c ? 30 : -30)))
    prims.push({ t: 'path', d: `M${r1(px + (ax - px) * 0.3)} ${r1(py + (ay - py) * 0.3)}L${r1(ax)} ${r1(ay)}H${r1(ax + side * 12)}`, stroke: CARD_COLOR.bone3Mark, width: 1.5 })
    const segs: ChipSeg[] = [{ text: name, tone: 'bone' }]
    if (alt) segs.push({ text: alt, tone: 'bone3' })
    chips.push({ segs, size: CARD_FS.chip, pos: side > 0 ? { left: r1(ax + 12), top: r1(ay - 15) } : { right: r1(S - ax + 12), top: r1(ay - 15) } })
  }

  prims.push(...reticlePrims(c, c, 18))
  chips.unshift(plateChip('Pass geometry · north up', { left: INSET, top: INSET }, 'bone2'))
  chips.push(plateChip(note, { left: INSET, bottom: INSET }, 'bone2'))
  const scale: ScaleBar = { px: Math.round(c / 2), label: fmtKm(halfKm / 2) }
  prims.push(...plateFrame(chips, scale, CARD_COLOR.bone3Mark))
  return { kind: 'plan', prims, chips, scale }
}

function planNote(verdict: Verdict, imageMiss?: 'transient' | 'permanent'): string {
  if (verdict === 'imaged') return imageMiss === 'permanent' ? 'Image opens in the app' : 'Image unavailable right now'
  if (verdict === 'could') return 'Commercial archive, not public'
  if (verdict === 'likely') return 'In swath, no public image yet'
  return 'Ground track at closest approach'
}

// ── The spec ────────────────────────────────────────────────────────────────────────────────

/** Mostly cloud: cloud at the spot, or most of the scene (as results' isClouded, so both sides agree). */
export function isCloudedCapture(c: Pick<CardCaptureInput, 'cloudCoverPct' | 'spot'> | undefined): boolean {
  return c?.spot === 'cloud' || (c?.cloudCoverPct ?? 0) >= CLOUDED_PCT
}

function readoutsFor(input: CardInput): Readout[] {
  const p = input.pass
  const dash = (v: number | undefined, fmt: (n: number) => string, unit?: string): Pick<Readout, 'value' | 'unit'> =>
    v === undefined || !Number.isFinite(v) ? { value: '—' } : { value: fmt(v), unit }
  const out: Readout[] = [{ label: 'Altitude', ...dash(p.altitudeKm, int, 'km') }]
  if (input.verdict === 'overhead') {
    out.push({ label: 'Elevation', ...dash(p.elevationDeg, (n) => `${int(n)}°`) }, { label: 'Speed', ...dash(p.groundSpeedKmS, (n) => fixed(n, 2), 'km/s') })
    return out
  }
  out.push({ label: 'Off-nadir', ...dash(p.offNadirDeg, (n) => `${fixed(n, 1)}°`) })
  const c = input.verdict === 'imaged' ? input.capture : undefined
  if (c) {
    const gsd = c.gsdM ?? NATIVE_GSD_M[c.collection]
    const mosaic = c.collection.startsWith('gibs-')
    out.push({ label: mosaic ? 'Mosaic pixel' : 'Pixel', ...dash(gsd, (n) => (n < 1 ? fixed(n, 2) : int(n)), 'm') })
  } else out.push({ label: 'Closest', ...dash(p.groundDistanceKm, int, 'km') })
  return out
}

/** Build the card from a normalised input (client: the selected pass; server: the stored share). */
export function buildCardSpec(input: CardInput): CardSpec {
  const h = passHeadlineParts(input)
  const c = input.capture
  const clouded = input.verdict === 'imaged' && !!c && (input.clouded ?? isCloudedCapture(c))
  // The words for a clouded picture (R2SH3). A caller that calls it clouded on evidence the capture
  // doesn't carry gets the most modest wording: cloud over the spot.
  const words = clouded ? (cloudWords(c?.cloudCoverPct, c?.spot) ?? cloudWords(undefined, 'cloud')) : undefined
  let plate: Plate
  if (input.verdict === 'imaged' && c && input.imageMiss !== 'permanent') {
    const crop = cardCrop(c)
    const gsd = c.gsdM ?? NATIVE_GSD_M[c.collection] ?? crop.metresPerPx
    const chip = plateChip(`${input.satName} · ${sensorName(c)} · ${gsd < 1 ? fixed(gsd, 2) : int(gsd)} m`, { left: INSET, top: INSET }, 'bone', CARD_FS.chipLead)
    const credit = plateChip(creditFor(c, input.tClosest), { left: INSET, bottom: INSET }, 'bone2', CARD_FS.micro)
    const scale = scaleFor(crop.metresPerPx)
    plate = {
      kind: 'image',
      crop,
      chip,
      credit,
      scale,
      clouded: words ? plateChip(words.chip, { left: INSET, bottom: INSET + 38 }, 'warn') : undefined,
      overlay: imageOverlay([chip, credit], scale),
      fallback: planPlate(input, planNote('imaged', 'transient')),
    }
  } else plate = planPlate(input, planNote(input.verdict, input.imageMiss))

  return {
    verdict: input.verdict,
    stamp: input.tClosest !== undefined ? localStamp(input.tClosest, input.timeZone) : '',
    lead: h.lead,
    place: h.place,
    tail: h.tail,
    sub: words?.sub,
    size: headlineSize(h.lead, h.place),
    readouts: readoutsFor(input),
    footLeft: FOOT_LEFT,
    host: input.host,
    plate,
  }
}

// ── Summary card (share SH6): the week at a place, with its closest look ────────────────────

export interface SummaryInput {
  placeLabel: string
  /** The rounded share point (2 decimals) */
  lat: number
  lon: number
  /**
   * N: distinct satellites that watched the place this week, i.e. with any pass (imaged, likely, could, overhead),
   * geostationary watchers excluded (they don't fly over). The results headline's number (headline().flewOver).
   */
  satellites: number
  /** The four verdict counts. `imaged` is K: the real images made public this week (results' headline().images). */
  counts: { imaged: number; likely: number; could: number; overhead: number }
  /** The image archives didn't answer: K is unknown, so the photos line says that instead of a count. */
  archiveDown?: boolean
  /** The archives were still answering when this was shared: K is a floor ("At least 4 photos…"). */
  partial?: boolean
  /** End of the 7-day window, epoch ms */
  windowEnd?: number
  timeZone?: string
  /** The closest look of the week (results' pickBestLook: the most zoomed-in clear photo), if any */
  best?: { satName: string; tClosest?: number; capture: CardCaptureInput }
  host: string
}

const SHORT: Record<Verdict, string> = { imaged: 'Photo', likely: 'Likely', could: 'Could', overhead: 'Overhead' }

/** The headline's lead (owner F, latest): "31 satellites watched" / "1 satellite watched" / "No satellite we track watched". */
export function watchedLead(n: number): string {
  const v = Math.max(0, Math.round(n))
  return v > 0 ? `${int(v)} ${v === 1 ? 'satellite' : 'satellites'} watched` : 'No satellite we track watched'
}

/** The archive outage, as the results' second line says it (src/ui/results/lib/copy.ts ARCHIVE_DOWN_LINE). */
export const ARCHIVE_DOWN_LINE = 'The image archives didn’t answer, so we can’t count the public photos right now.'
/** The same, where the card's sub-line has room for one line. */
export const ARCHIVE_DOWN_SHORT = 'The image archives didn’t answer.'

/**
 * The second line (owner F): "31 photos were made public." / "1 photo was made public." / "At least 4 photos were made
 * public." The results panel's photosLine words, except a zero: the summary's first sentence already says "this week",
 * so it reads "No photos were made public." rather than repeating it.
 */
export function photosSentence(k: number, opts: { archiveDown?: boolean; partial?: boolean; short?: boolean } = {}): string {
  if (opts.archiveDown) return opts.short ? ARCHIVE_DOWN_SHORT : ARCHIVE_DOWN_LINE
  const v = Math.max(0, Math.round(k))
  if (v <= 0) return 'No photos were made public.'
  const lead = opts.partial ? 'At least ' : ''
  return v === 1 ? `${lead}1 photo was made public.` : `${lead}${int(v)} photos were made public.`
}

/** "31 satellites watched Waterloo this week." (R3-13: the summary share's first sentence, everywhere it is printed) */
export function summaryHeadline(i: Pick<SummaryInput, 'satellites' | 'placeLabel'>): string {
  return `${watchedLead(i.satellites)} ${i.placeLabel} this week.`
}

/** "31 satellites watched Waterloo this week. 12 photos were made public." (R3-13, owner F) */
export function summarySentences(i: Pick<SummaryInput, 'satellites' | 'placeLabel' | 'counts' | 'archiveDown' | 'partial'>): string {
  return `${summaryHeadline(i)} ${photosSentence(i.counts.imaged, i)}`
}

/** "31 satellites watched *Waterloo this week.*" + "12 photos were made public." over the week's closest look, with the four verdict counts. */
export function buildSummarySpec(i: SummaryInput): CardSpec {
  const n = Math.max(0, Math.round(i.satellites))
  const cps = Array.from(i.placeLabel)
  const place = cps.length > PLACE_MAX ? `${cps.slice(0, PLACE_MAX - 1).join('').trimEnd()}…` : i.placeLabel
  // The results headline, in the card's two type faces (R3-13): the condensed lead, then the serif place.
  const lead = watchedLead(n)
  const tail = place.endsWith('…') ? '' : ' this week.'
  let plate: Plate
  const c = i.best?.capture
  if (c && i.best) {
    const crop = cardCrop(c)
    const gsd = c.gsdM ?? NATIVE_GSD_M[c.collection] ?? crop.metresPerPx
    const chip = plateChip(`Closest look · ${i.best.satName} · ${gsd < 1 ? fixed(gsd, 2) : int(gsd)} m`, { left: INSET, top: INSET }, 'bone', CARD_FS.chipLead)
    const credit = plateChip(creditFor(c, i.best.tClosest), { left: INSET, bottom: INSET }, 'bone2', CARD_FS.micro)
    const scale = scaleFor(crop.metresPerPx)
    plate = { kind: 'image', crop, chip, credit, scale, overlay: imageOverlay([chip, credit], scale), fallback: emptyPlate(planNote('imaged', 'transient')) }
  } else {
    // Say "no public photo" only when K says so: with the archives down (K unknown) or a count but no picture in the link,
    // the plate stays neutral beside the sub-line ("The image archives didn’t answer." / "1 photo was made public.").
    const none = !i.archiveDown && Math.round(i.counts.imaged) <= 0
    plate = emptyPlate(none ? 'No public photo this week' : 'No photo to show')
  }
  const day = i.windowEnd !== undefined ? localStamp(i.windowEnd, i.timeZone).split(' · ')[0] : ''
  const readouts: Readout[] = (['imaged', 'likely', 'could', 'overhead'] as const).map((v) => ({ label: SHORT[v], value: int(i.counts[v]) }))
  return {
    verdict: n > 0 ? 'imaged' : 'overhead',
    stamp: day ? `7 days to ${day}` : 'Last 7 days',
    lead,
    place,
    tail,
    sub: photosSentence(i.counts.imaged, { ...i, short: true }),
    // The tail sets on the place line, so it counts toward what the place line must hold.
    size: headlineSize(lead, `${place}${tail}`),
    readouts,
    // Four columns of 116px: a six-character count ("12,345") steps down so it clears the next rule.
    readoutSize: readouts.some((r) => r.value.length > 5) ? 21 : 26,
    footLeft: FOOT_LEFT,
    host: i.host,
    plate,
  }
}

/** No picture to show (none this week, or the archive was slow): the instrument face alone (grid, reticle, a plain note). */
function emptyPlate(note: string): PlanPlate {
  const S = PLATE
  const c = S / 2
  const step = S / 12
  let grid = ''
  for (let k = 1; k < 12; k++) grid += `M${k * step} 0V${S}M0 ${k * step}H${S}`
  const chips = [plateChip(note, { left: INSET, bottom: INSET }, 'bone2')]
  const scale: ScaleBar = { px: 0, label: '' }
  return {
    kind: 'plan',
    prims: [
      { t: 'path', d: grid, stroke: 'rgba(236,232,224,0.05)', width: 1 },
      { t: 'path', d: `M${c} 0V${S}M0 ${c}H${S}`, stroke: 'rgba(236,232,224,0.09)', width: 1 },
      ...reticlePrims(c, c, 18),
      ...plateFrame(chips, scale, CARD_COLOR.bone3Mark),
    ],
    chips,
    scale,
  }
}

/** The plate to draw: the picture, or its geometry fallback when the picture couldn't be fetched. */
export function plateOrFallback(plate: Plate, haveImage: boolean): Plate {
  return plate.kind === 'image' && !haveImage ? plate.fallback : plate
}

export const TONE_COLOR: Record<Tone, string> = {
  bone: CARD_COLOR.bone,
  bone2: CARD_COLOR.bone2,
  bone3: CARD_COLOR.bone3,
  signal: CARD_COLOR.signal,
  warn: CARD_COLOR.warn,
}

/** Chip box metrics (px) shared by the renderers: padding and the gap between segments. */
export const CHIP_BOX = { padX: 10, padTop: 7, padBottom: 6, gap: 10, lineH: 1.3 } as const
