/**
 * 01 / SUMMARY pieces: the headline ("In the last 7 days, 9 satellites photographed Waterloo."), the
 * second line, readouts per verdict (each jumps to its group in the list) and the report's caveats.
 *
 * Numbers are honest and stable (M03 / PRD-04): the headline integer never counts (it says "at least"
 * while weather mosaics are still being verified), readouts count up once per report and roll when
 * the final report changes them, and coming back from a pass shows final values at once.
 */
import type { CSSProperties, ReactNode } from 'react'
import { Button, Glyph, cx, prefersReducedMotion } from '@/ui/system'
import { Count } from './Count'
import { Paragraph } from './Text'
import { geoSentence, int, placeParts, plain, radarSentence } from './lib/copy'
import { VERDICTS, VERDICT_GLYPH, VERDICT_META, verdictUnit, type Verdict } from './lib/meta'
import { fmtDayMonth } from './lib/time'
import type { ResultsModel } from './model'
import s from './results.module.css'

/** A window that ended more than an hour ago is described by its dates, not as "the last 7 days". */
export const isOldWindow = (model: ResultsModel) => model.report.windowEnd < Date.now() - 3_600_000

/** Stagger slot for the handoff entrance (headline 0, hero 1, verdicts 2, notes 3 → 60 ms apart). */
export const enterStyle = (i: number) => ({ '--i': i }) as CSSProperties

/** "In the last 7 days" / "Between 29 Oct and 5 Nov" */
function windowPhrase(model: ResultsModel): string {
  const { report, windowDays, tz } = model
  if (isOldWindow(model)) return `Between ${fmtDayMonth(report.windowStart, tz)} and ${fmtDayMonth(report.windowEnd, tz)}`
  return Math.round(windowDays) === 7 ? 'In the last 7 days' : `In the last ${int(windowDays)} days`
}

function PlaceName({ label }: { label: string }) {
  const [article, name] = placeParts(label)
  return (
    <>
      {article}
      <span className={s.serif}>{name}</span>
    </>
  )
}

/**
 * The headline sentence. `compact` is the phone sheet header style. `enter` plays the line wipe of
 * the results handoff (first appearance per report only).
 */
export function Headline({ model, compact = false, enter = false }: { model: ResultsModel; compact?: boolean; enter?: boolean }) {
  const { head, report } = model
  const label = report.place.label
  const n = head.photographed
  const cls = cx(compact ? s.mHeadline : s.headline, enter && s.enterWipe)
  const week = isOldWindow(model) ? 'that week' : 'this week'
  let body: ReactNode
  if (model.archiveFailed) body = <span className={s.outageHead}>The image archives didn’t answer.</span>
  else if (n === 0 && head.zeroKind === 'dark')
    body = (
      <>
        No camera could see <PlaceName label={label} /> {week}: {head.sunNeverRose ? 'the sun never rose' : 'the sun barely rose'}.
      </>
    )
  else if (n === 0)
    body = (
      <>
        No public satellite caught a clear look at <PlaceName label={label} /> {week}.
      </>
    )
  else
    body = (
      <>
        {windowPhrase(model)}, {report.partial ? 'at least ' : null}
        <strong>
          <Count value={n} className={s.numDisplay} /> {n === 1 ? 'satellite' : 'satellites'} photographed
        </strong>{' '}
        <PlaceName label={label} />.
      </>
    )
  return (
    // Announced when it changes (the final report replacing the partial one), not on every render.
    <h2 className={cls} aria-live="polite" style={enterStyle(0)}>
      {body}
    </h2>
  )
}

/** The second line: who else passed, or plainly why there is no picture. */
export function MoreLine({ model, compact = false, enter = false, onRetry }: { model: ResultsModel; compact?: boolean; enter?: boolean; onRetry?: () => void }) {
  const { head, report, best } = model
  const cls = cx(compact ? s.mMore : s.headlineMore, enter && s.enter)
  const style = enterStyle(0.5)
  if (model.archiveFailed) {
    const [article, name] = placeParts(report.place.label)
    return (
      <div className={s.outage} style={style}>
        <p className={cx(cls, s.moreProse)}>
          Everything that passed over {article}
          {name} is below, from orbital geometry alone.
        </p>
        {onRetry ? (
          <Button variant="primary" onClick={onRetry} className={s.retry}>
            Try again
          </Button>
        ) : null}
      </div>
    )
  }
  if (!head.photographed) {
    // Dark: radar needs no light. Otherwise the geostationary imager that sees it all week, else why.
    const sentence =
      head.zeroKind === 'dark' && head.radar
        ? radarSentence(head.radar)
        : best?.kind === 'geo'
          ? geoSentence(best.watcher, model.windowDays)
          : undefined
    if (sentence) return <Paragraph sentences={[sentence]} className={cx(cls, s.moreProse)} />
    const why = head.zeroReason
    if (!why || head.zeroKind === 'dark') return null
    return (
      <p className={cx(cls, s.moreProse)} style={style}>
        {why[0].toUpperCase() + why.slice(1)}.
      </p>
    )
  }
  if (!head.more) return null
  return (
    <p className={cls} style={style}>
      <Count value={head.more} countKey={`${report.windowEnd}:more`} delay={200} className={s.numDisplay} /> more passed within view.
    </p>
  )
}

/** Summary readouts: one per verdict, with its unit, each jumping to its group in the list. */
export function Verdicts({ model, enter = false }: { model: ResultsModel; enter?: boolean }) {
  const { report } = model
  const counts = report.counts
  const jump = (v: Verdict) =>
    document.getElementById(`passes-${v}`)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
  // The outline diamond is Sentinel-2 / Landsat geometry; when none are counted, 'likely' is weather.
  const likelyOptical = model.lanes.likely.passes.some((p) => model.meta(p.norad).category === 'open-optical')
  const glyph = (v: Verdict) => (v === 'likely' && !likelyOptical ? 'weather-leo' : VERDICT_GLYPH[v])
  return (
    <div className={cx(s.verdicts, enter && s.enter)} role="group" aria-label="Passes by verdict. Each jumps to its list." style={enterStyle(2)}>
      {VERDICTS.map((v, i) => {
        const value = counts[v]
        const words = VERDICT_META[v]
        const tone = v === 'imaged' && value > 0 ? s.signal : value === 0 ? s.zero : undefined
        const defId = `verdict-def-${v}`
        return (
          <button
            key={v}
            type="button"
            className={s.verdict}
            onClick={() => jump(v)}
            disabled={value === 0}
            title={words.definition}
            aria-label={`${int(value)} ${verdictUnit(v, value)}: ${words.title}`}
            aria-describedby={defId}
          >
            <span className={cx(s.verdictTop, tone)}>
              <Glyph name={glyph(v)} size={12} color={v === 'imaged' && value > 0 ? 'var(--signal)' : undefined} />
              <Count value={value} countKey={`${report.windowEnd}:${v}`} delay={120 + i * 60} className={s.verdictValue} />
              <span className={s.verdictUnit}>{verdictUnit(v, value)}</span>
            </span>
            <span className={s.verdictLabel}>{words.title}</span>
            <span id={defId} className="sr-only">
              {words.definition}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Caveats in bone-3 mono: what was counted, and the report's own notes (outages etc.). */
export function Notes({ model, enter = false }: { model: ResultsModel; enter?: boolean }) {
  const { report, head } = model
  const counts = report.counts
  const notes = report.notes ?? []
  return (
    <div className={cx(s.notes, enter && s.enter)} style={enterStyle(3)}>
      {head.images > 0 ? (
        <p className={s.footnote}>
          <b>{int(head.detailed)}</b> detailed {head.detailed === 1 ? 'image' : 'images'} (Sentinel-2, Landsat, 10–30 m)
          {head.mosaics ? (
            <>
              {' '}
              · <b>{int(head.mosaics)}</b> daily weather {head.mosaics === 1 ? 'mosaic' : 'mosaics'} (250–375 m)
            </>
          ) : null}
          . {int(counts.passes)} passes from {int(counts.satellitesConsidered)} imaging and crewed satellites checked.
        </p>
      ) : (
        <p className={s.footnote}>
          {int(counts.passes)} passes from {int(counts.satellitesConsidered)} imaging and crewed satellites checked.
        </p>
      )}
      {notes.length ? (
        <ul className={s.notes}>
          {notes.map((n, i) => (
            <li key={i} className={s.footnote}>
              <span>{superscript(i + 1)}</span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Plain-text headline for aria labels and share text. */
export function headlineText(model: ResultsModel): string {
  const n = model.head.photographed
  if (model.archiveFailed) return 'The image archives didn’t answer.'
  if (!n) return `No public satellite caught a clear look at ${model.report.place.label}.`
  return plain([`${windowPhrase(model)}, ${n} ${n === 1 ? 'satellite' : 'satellites'} photographed ${model.report.place.label}.`])
}

const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const superscript = (n: number) => String(n).replace(/\d/g, (d) => SUP[Number(d)])
