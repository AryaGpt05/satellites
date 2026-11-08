/** Renders copy built in lib/copy.ts: prose with numbers set in mono (DESIGN §3). */
import { Fragment } from 'react'
import { tightUnit, type Sentence } from './lib/copy'
import s from './results.module.css'

export function SentenceText({ parts }: { parts: Sentence }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          <Fragment key={i}>{p}</Fragment>
        ) : (
          <span key={i} className={s.num}>
            {p.n}
            {p.u ? tightUnit(p.u) ? p.u : <span className={s.unit}>{p.u}</span> : null}
          </span>
        ),
      )}
    </>
  )
}

export function Paragraph({ sentences, className }: { sentences: Sentence[]; className?: string }) {
  return (
    <p className={className ?? s.prose}>
      {sentences.map((sentence, i) => (
        <Fragment key={i}>
          {i ? ' ' : null}
          <SentenceText parts={sentence} />
        </Fragment>
      ))}
    </p>
  )
}
