/**
 * Copy: every sentence the results UI says, built from real numbers (DESIGN §7: declarative,
 * specific, quietly uncanny, second person). Sentences are arrays of parts so the renderer can set
 * numbers in mono (DESIGN §3: "Numbers are always mono"); `plain()` flattens them for share text,
 * aria labels and tests.
 */
import type { Capture, GeoWatcher, Pass, Report } from '@/types'
import { isDailyMosaic, sensorName } from './captures'
import type { MetaFn, SatMeta } from './meta'
import { fmtLocalTime, zoneAbbr } from './time'

export type Part = string | { n: string; u?: string }
export type Sentence = Part[]

export const num = (n: string, u?: string): Part => ({ n, u })

export function plain(parts: Sentence | Sentence[]): string {
  const flat = (s: Sentence) => s.map((p) => (typeof p === 'string' ? p : p.u ? `${p.n} ${p.u}` : p.n)).join('')
  if (parts.length && Array.isArray(parts[0])) return (parts as Sentence[]).map(flat).join(' ')
  return flat(parts as Sentence)
}

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const int = (n: number) => nf0.format(Math.round(n))
export const dec1 = (n: number) => nf1.format(n)
export const dec2 = (n: number) => nf2.format(n)

// ── compass ───────────────────────────────────────────────────────────────────────────────

const WORDS8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
const ABBR16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const norm = (deg: number) => ((deg % 360) + 360) % 360

/** 8-point compass word for prose: 194° → "south". */
export function compassWord(deg: number): string {
  return WORDS8[Math.round(norm(deg) / 45) % 8]
}
/** 16-point abbreviation for readouts: 194.6° → "SSW". */
export function compassAbbr(deg: number): string {
  return ABBR16[Math.round(norm(deg) / 22.5) % 16]
}

// ── headline ──────────────────────────────────────────────────────────────────────────────

export interface Headline {
  /** Distinct satellites with at least one real image */
  photographed: number
  /** Distinct other satellites that passed within view (likely / could / overhead) */
  more: number
  /** Total real images */
  images: number
  /** Of which per-scene detailed images (Sentinel-2, Landsat) */
  detailed: number
  /** Of which coarse daily weather mosaics */
  mosaics: number
  /** Plain reason when nothing photographed the place */
  zeroReason?: string
}

export function headline(report: Pick<Report, 'passes' | 'captures' | 'notes'>, meta: MetaFn): Headline {
  const imagedSats = new Set<number>()
  const viewSats = new Set<number>()
  let detailed = 0
  let mosaics = 0
  const byId = new Map(report.captures.map((c) => [c.id, c]))
  for (const p of report.passes) {
    if (p.verdict === 'imaged') {
      imagedSats.add(p.norad)
      const c = p.captureId ? byId.get(p.captureId) : undefined
      if (c && isDailyMosaic(c)) mosaics++
      else detailed++
    } else viewSats.add(p.norad)
  }
  for (const n of imagedSats) viewSats.delete(n)
  const h: Headline = {
    photographed: imagedSats.size,
    more: viewSats.size,
    images: detailed + mosaics,
    detailed,
    mosaics,
  }
  if (!h.photographed) h.zeroReason = zeroReason(report, meta)
  return h
}

function zeroReason(report: Pick<Report, 'passes' | 'notes'>, meta: MetaFn): string {
  const notes = (report.notes ?? []).join(' ')
  if (/archives? (could not be reached|were too slow)/i.test(notes)) return 'the image archives did not answer in time'
  const open = report.passes.filter((p) => p.verdict === 'likely' && meta(p.norad).category === 'open-optical')
  if (open.length)
    return `Sentinel-2 or Landsat crossed it ${open.length === 1 ? 'once' : `${int(open.length)} times`} in daylight, but no scene has been published yet`
  if (report.passes.length && report.passes.every((p) => p.sunElevationDeg < 5)) return 'the sun barely rose there'
  return 'no open imaging satellite crossed it in daylight'
}

// ── geostationary ─────────────────────────────────────────────────────────────────────────

/** "GOES-19 has photographed this spot every 10 minutes, all week: 1,008 times." */
export function geoSentence(g: GeoWatcher, days: number): Sentence {
  const span = Math.round(days) === 7 ? 'all week' : `for ${int(days)} days`
  return [`${g.name} has photographed this spot every `, num(int(g.cadenceMin), 'minutes'), `, ${span}: `, num(int(g.imagesInWindow)), ' times.']
}

// ── pass detail ───────────────────────────────────────────────────────────────────────────

export interface PassCopyCtx {
  pass: Pass
  meta: SatMeta
  capture?: Capture
  timeZone: string
  placeLabel: string
}

/** "11:21:13 EST" */
function localClock(ms: number, tz: string, seconds = true): Part {
  return num(fmtLocalTime(ms, tz, seconds), zoneAbbr(ms, tz))
}

/** "786 km overhead" or "786 km up, 61 km to the west" */
function where(p: Pass): Part[] {
  if (p.groundDistanceKm < 15) return [num(int(p.altitudeKm), 'km'), ' overhead']
  return [num(int(p.altitudeKm), 'km'), ' up, ', num(int(p.groundDistanceKm), 'km'), ` to the ${compassWord(p.azimuthDeg)}`]
}

function looking(off: number): Sentence {
  if (off < 1.5) return ['It was looking straight down.']
  return ['It was looking ', num(dec1(off), '°'), ' off straight down.']
}

/**
 * One precise paragraph about a pass, as sentences. The order is always: what crossed, when, where,
 * how it moved → what that means for the image → what we can't know.
 */
export function passSentences({ pass: p, meta, capture, timeZone: tz, placeLabel }: PassCopyCtx): Sentence[] {
  const name = meta.name
  const moving: Part[] = [`, moving ${compassWord(p.headingDeg)} at `, num(dec2(p.groundSpeedKmS), 'km/s'), '.']
  const out: Sentence[] = []
  switch (p.verdict) {
    case 'imaged': {
      if (capture && isDailyMosaic(capture)) {
        out.push([`${name} crossed `, ...where(p), ' at ', localClock(p.tClosest, tz), ...moving])
        out.push([
          `Its ${sensorName(capture)} imager swept ${placeLabel} into NASA’s daily true-colour mosaic at `,
          num(int(capture.gsdM), 'm'),
          ' per pixel. Coarse, but it is a real picture of that day.',
        ])
      } else {
        out.push([`${name} crossed `, ...where(p), ' at ', localClock(p.tClosest, tz), ...moving])
        out.push(looking(p.offNadirDeg))
        if (capture?.cloudCoverPct !== undefined) out.push(['Cloud cover across the scene: ', num(int(capture.cloudCoverPct), '%'), '.'])
      }
      break
    }
    case 'likely': {
      const swath = meta.profile?.swathKm
      out.push([
        `${name} crossed `,
        ...where(p),
        ' at ',
        localClock(p.tClosest, tz),
        ...(swath ? [', inside its ', num(int(swath), 'km'), ' swath.'] : ['.']),
      ])
      if (meta.category === 'open-optical') {
        out.push(['It was daylight, so it almost certainly recorded this spot. No scene from this pass has been published yet; archives can lag by a day or more.'])
      } else if (p.sunElevationDeg < 0) {
        out.push(['It was dark here. Weather imagers keep scanning at night in infrared, so it saw your clouds, not your streets.'])
      } else if (meta.profile?.gibs) {
        out.push(['NASA’s daily mosaic for this pass could not be confirmed at your spot.'])
      } else {
        out.push(['Its images feed weather forecasts; they are not published as pictures we can show.'])
      }
      break
    }
    case 'could': {
      out.push([`${name} passed within view at `, localClock(p.tClosest, tz, false), ', ', num(int(p.groundDistanceKm), 'km'), ` to the ${compassWord(p.azimuthDeg)}.`])
      if (meta.category === 'radar') {
        out.push(['Radar sees through cloud and darkness. Pointing ', num(dec1(p.offNadirDeg), '°'), ` to the side, it could have mapped ${placeLabel}. We can’t know whether it did.`])
      } else {
        out.push(['Pointing ', num(dec1(p.offNadirDeg), '°'), ` off straight down, it could have photographed ${placeLabel}. We can’t know whether it did.`])
      }
      break
    }
    case 'overhead': {
      out.push([
        `${name} passed `,
        num(int(p.altitudeKm), 'km'),
        ' up at ',
        localClock(p.tClosest, tz, false),
        ', ',
        num(int(p.elevationDeg), '°'),
        ` above your horizon to the ${compassWord(p.azimuthDeg)}.`,
      ])
      if (p.sunElevationDeg < -6) out.push(['It was dark where you are. If the station was still in sunlight, it crossed your sky as a bright, steady point.'])
      break
    }
  }
  return out
}

// ── share ─────────────────────────────────────────────────────────────────────────────────

/** Card / post headline: "Sentinel-2C photographed Waterloo." */
export function shareHeadline(verdict: Pass['verdict'], name: string, place: string): { lead: string; place: string } {
  switch (verdict) {
    case 'imaged':
      return { lead: `${name} photographed`, place }
    case 'likely':
      return { lead: `${name} looked down on`, place }
    case 'could':
      return { lead: `${name} passed within view of`, place }
    case 'overhead':
      return { lead: `${name} passed over`, place }
  }
}
