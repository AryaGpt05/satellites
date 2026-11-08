/**
 * 01 / SUMMARY: the headline ("In the last 7 days, 9 satellites photographed Waterloo."), the second
 * line, readouts per verdict (each jumps to its group in the list), the image breakdown and the
 * report's own caveats as footnotes.
 */
import type { ReactNode } from 'react'
import { Glyph, LiveDot, Num, cx, prefersReducedMotion } from '@/ui/system'
import { int } from './lib/copy'
import { VERDICTS, VERDICT_GLYPH, type Verdict } from './lib/meta'
import type { ResultsModel } from './model'
import s from './results.module.css'

const LABEL: Record<Verdict, [string, string]> = {
  imaged: ['Photographed', 'images'],
  likely: ['Likely', 'in swath'],
  could: ['Could have', 'pointed here'],
  overhead: ['Overhead', 'crewed'],
}

/** The headline sentence. `size` picks the panel (desktop body) or the compact mobile header style. */
export function Headline({ model, compact = false }: { model: ResultsModel; compact?: boolean }) {
  const { head, report, windowDays } = model
  const place = report.place.label
  const window = Math.round(windowDays) === 7 ? 'In the last 7 days' : `In the last ${int(windowDays)} days`
  const n = head.photographed
  const cls = compact ? s.mHeadline : s.headline
  if (n === 0) {
    return (
      <h2 className={cls}>
        No public satellite caught a clear look at <span className={s.serif}>{place}</span> this week.
      </h2>
    )
  }
  return (
    <h2 className={cls}>
      {window},{' '}
      <strong>
        <Num value={n} duration={900} className={s.num} /> {n === 1 ? 'satellite' : 'satellites'} photographed
      </strong>{' '}
      <span className={s.serif}>{place}</span>.
    </h2>
  )
}

export function MoreLine({ model }: { model: ResultsModel }) {
  const { more, zeroReason, photographed } = model.head
  // With no photographs, the second line says why, plainly.
  if (!photographed && zeroReason) return <p className={s.headlineMore}>{zeroReason[0].toUpperCase() + zeroReason.slice(1)}.</p>
  if (!more) return null
  return (
    <p className={s.headlineMore}>
      <Num value={more} duration={900} delay={200} className={s.num} /> more passed within view.
    </p>
  )
}

export function Summary({ model, showHeadline = true }: { model: ResultsModel; showHeadline?: boolean }) {
  const { report, head } = model
  const counts = report.counts
  const jump = (v: Verdict) =>
    document.getElementById(`passes-${v}`)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
  const notes = report.notes ?? []
  return (
    <div className={s.section}>
      {showHeadline ? (
        <div>
          <Headline model={model} />
          <MoreLine model={model} />
        </div>
      ) : (
        // Phones: the headline rides in the sheet header; its second line opens the body.
        <MoreLine model={model} />
      )}

      <div className={s.verdicts} role="group" aria-label="Passes by verdict. Each jumps to its list.">
        {VERDICTS.map((v, i) => {
          const value = counts[v]
          const tone = v === 'imaged' && value > 0 ? s.signal : value === 0 ? s.zero : undefined
          return (
            <button
              key={v}
              type="button"
              className={s.verdict}
              onClick={() => jump(v)}
              disabled={value === 0}
              aria-label={`${int(value)} ${LABEL[v].join(' ')}`}
            >
              <span className={cx(s.verdictTop, tone)}>
                <Glyph name={VERDICT_GLYPH[v]} size={12} color={v === 'imaged' && value > 0 ? 'var(--signal)' : undefined} />
                <Num value={value} duration={700} delay={120 + i * 60} className={s.verdictValue} />
              </span>
              <span className={s.verdictLabel}>
                {LABEL[v][0]}
                <br />
                {LABEL[v][1]}
              </span>
            </button>
          )
        })}
      </div>

      <div className={s.notes}>
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
        {report.partial ? (
          <p className={cx(s.footnote, s.pending)}>
            <LiveDot /> Verifying NASA weather mosaics. Counts may still rise.
          </p>
        ) : null}
        {notes.length ? (
          <ul className={s.notes}>
            {notes.map((n, i) => (
              <Footnote key={i} mark={superscript(i + 1)}>
                {n}
              </Footnote>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

function Footnote({ mark, children }: { mark: string; children: ReactNode }) {
  return (
    <li className={s.footnote}>
      <span>{mark}</span>
      <span>{children}</span>
    </li>
  )
}

const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const superscript = (n: number) => String(n).replace(/\d/g, (d) => SUP[Number(d)])
