/**
 * 01 / SUMMARY pieces: the headline ("In the last 7 days, 256 satellites watched Waterloo."), the second
 * line ("27 images were made public.": photos, weather mosaics and radar images, one count), readouts per verdict
 * (each jumps to its group in the list) and the report's caveats (the footnote breaks the count down). Owner request F: these are the final words; every place that says it uses these helpers.
 *
 * Numbers are honest and stable (A1): the headline integer is final as soon as the passes exist and never
 * counts; only the photos line can be partial ("At least 4 photos…") and it settles in place (a 200 ms
 * crossfade of the changed digits). Readouts count up once per report; coming back from a pass shows final
 * values at once.
 */
import type { CSSProperties, ReactNode } from 'react'
import { Button, Glyph, cx, prefersReducedMotion } from '@/ui/system'
import { Count } from './Count'
import { Paragraph } from './Text'
import { ARCHIVE_DOWN_LINE, darkSentences, geoSentence, int, photosLine, placeParts, plain, radarSentence, watchedPhrase, type Sentence } from './lib/copy'
import { VERDICTS, VERDICT_GLYPH, VERDICT_META, verdictUnit, type Verdict } from './lib/meta'
import { fmtDayMonth } from './lib/time'
import type { ResultsModel } from './model'
import s from './results.module.css'

/** A window that ended more than an hour ago is described by its dates, not as "the last 7 days". */
export const isOldWindow = (model: ResultsModel) => model.report.windowEnd < Date.now() - 3_600_000

/**
 * The photo count can still grow: a partial report, or a final one whose weather mosaics are still being checked in
 * the background (PH-02: those patched "23 photos" to 27 and 28 after a definite paint). Reads "At least K" and
 * settles in place.
 */
export const countPending = (report: { partial?: boolean; lateChecks?: number }) => !!report.partial || (report.lateChecks ?? 0) > 0

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
 * The headline sentence: "In the last 7 days, **256 satellites watched** *Waterloo*." (owner F, latest) `compact` is the phone
 * sheet header style. `enter` plays the line wipe of the results handoff (first appearance per report only).
 */
export function Headline({ model, compact = false, enter = false }: { model: ResultsModel; compact?: boolean; enter?: boolean }) {
  const { head, report } = model
  const label = report.place.label
  const n = head.flewOver
  const cls = cx(compact ? s.mHeadline : s.headline, enter && s.enterWipe)
  const body: ReactNode =
    n === 0 ? (
      <>
        No satellite we track watched <PlaceName label={label} /> {weekWord(model)}.
      </>
    ) : (
      <>
        {windowPhrase(model)},{' '}
        <strong>
          <span className={s.numDisplay}>{int(n)}</span> {n === 1 ? 'satellite' : 'satellites'} watched
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

const weekWord = (model: ResultsModel) => (isOldWindow(model) ? 'that week' : 'this week')

/**
 * The second line: how many images were made public (owner F; one count, radar images included). When there are none, one plain sentence says
 * why (the sun, the archives' lag, the geostationary imager that sees it anyway). An archive outage says so,
 * with Try again.
 *
 * `onShare`: Share rides at the end of this line (the week's summary: the headline's own numbers and the gallery's
 * first image). It is where the finding is read, on every layout, and takes no row of its own: a hairline button at
 * the summary's right edge, level with the line. Not offered when nothing watched the place, or while the archives
 * are down (Try again is the action then).
 */
export function MoreLine({
  model,
  compact = false,
  enter = false,
  onRetry,
  onShare,
}: {
  model: ResultsModel
  compact?: boolean
  enter?: boolean
  onRetry?: () => void
  onShare?: () => void
}) {
  const { head, report, best } = model
  const share = !!onShare && head.flewOver > 0
  // With Share the row carries the entrance and the line's top margin, so the two enter (and sit) as one.
  const cls = cx(compact ? s.mMore : s.headlineMore, share ? s.moreInRow : enter && s.enter)
  const style = enterStyle(0.5)
  if (model.archiveFailed) {
    return (
      <div className={cx(s.outage, enter && s.enter)} style={style}>
        <p className={cx(compact ? s.mMore : s.headlineMore, s.moreProse)}>{ARCHIVE_DOWN_LINE}</p>
        {onRetry ? (
          <Button variant="primary" onClick={onRetry} className={s.retry}>
            Try again
          </Button>
        ) : null}
      </div>
    )
  }
  const k = head.images
  const sentence = (
    <p className={cls} style={share ? undefined : style}>
      {k > 0 ? <PhotosCount k={k} partial={countPending(report)} /> : photosLine(0, { week: weekWord(model) })}
    </p>
  )
  const line = share ? (
    <div className={cx(s.moreRow, compact && s.mMoreRow, enter && s.enter)} style={style}>
      {sentence}
      <button type="button" className={s.weekShare} onClick={onShare} aria-label={`Share ${weekWord(model)} at ${report.place.label}`}>
        <Glyph name="share" size={12} />
        Share
      </button>
    </div>
  ) : (
    sentence
  )
  if (k > 0) return line
  // No photo: one plain sentence on why (dark → the sun, and the infrared sweeps; else radar / geostationary / the reason).
  let why: Sentence[] | undefined
  if (head.zeroKind === 'dark') why = darkSentences(head)
  else if (head.radar && head.zeroKind !== 'unpublished') why = [radarSentence(head.radar)]
  else if (best?.kind === 'geo') why = [geoSentence(best.watcher, model.windowDays)]
  else if (head.zeroReason && head.zeroKind !== 'archive') why = [[head.zeroReason[0].toUpperCase() + head.zeroReason.slice(1) + '.']]
  return (
    <>
      {line}
      {why ? <Paragraph sentences={why} className={cx(compact ? s.mWhy : s.why, enter && s.enter)} /> : null}
    </>
  )
}

/** "27 images were made public." with the number set in the display face; partial → final settles in place. */
function PhotosCount({ k, partial }: { k: number; partial: boolean }) {
  return (
    <>
      <span className={cx(s.atLeast, !partial && s.atLeastOff)} aria-hidden={!partial}>
        At least{' '}
      </span>
      <Count value={k} className={s.numDisplay} />
      {k === 1 ? ' image was made public.' : ' images were made public.'}
    </>
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
          {head.radarImages ? (
            <>
              {' '}
              · <b>{int(head.radarImages)}</b> radar {head.radarImages === 1 ? 'image' : 'images'} (Sentinel-1, 20 m)
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

/** Plain-text headline + second line, for aria labels and share text (mirrors Headline / MoreLine). */
export function headlineText(model: ResultsModel): string {
  const { head, report } = model
  const n = head.flewOver
  const label = report.place.label
  const first = n === 0 ? `No satellite we track watched ${label} ${weekWord(model)}.` : `${windowPhrase(model)}, ${watchedPhrase(n)} ${label}.`
  const second = model.archiveFailed ? ARCHIVE_DOWN_LINE : photosLine(head.images, { partial: countPending(report), week: weekWord(model) })
  return plain([first, ' ', second])
}

const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const superscript = (n: number) => String(n).replace(/\d/g, (d) => SUP[Number(d)])
