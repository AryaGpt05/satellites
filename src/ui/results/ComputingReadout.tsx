/**
 * <ComputingReadout/> (phase 'computing'): the engine's progress as instrument lines, never a spinner.
 *
 *   ── COMPUTING ─────────────────────────────── T+1.84 S
 *   Waterloo
 *   43.4723°N 80.5449°W · AMERICA/TORONTO · ONTARIO, CANADA
 *   01  CAT    CATALOG · 16,912 OBJECTS              0.21 S  OK
 *   02  PROP   PROPAGATING ORBITS · 1,203 / 2,410    1.10 S  ▮
 *   03  ARCH   —
 *   04  MATCH  —
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────  62%
 *
 * Reads `store.progress` (latest event only) and keeps its own per-stage history and timings.
 * Slow archives get an honest note after a few seconds.
 */
import { useEffect, useRef, useState } from 'react'
import { timeZoneAt } from '@/imagery'
import { useApp } from '@/state/store'
import type { ProgressEvent } from '@/types'
import { Button, Kbd, Rule, ScrambleOnce, cx, fmtLat, fmtLon, fmtUtc, useExitClone, useIsMobile } from '@/ui/system'
import s from './ComputingReadout.module.css'

type Stage = Exclude<ProgressEvent['stage'], 'done'>
const STAGES: { stage: Stage; tag: string; idle: string; done: string }[] = [
  { stage: 'catalog', tag: 'Cat', idle: 'Orbital catalog', done: 'Catalog loaded' },
  { stage: 'propagate', tag: 'Prop', idle: 'Propagate orbits · 7 days', done: 'Orbits propagated' },
  { stage: 'archive', tag: 'Arch', idle: 'Sentinel-2 + Landsat archives', done: 'Archives searched' },
  { stage: 'match', tag: 'Match', idle: 'Match scenes to passes', done: 'Scenes matched' },
]
const ORDER: Record<ProgressEvent['stage'], number> = { catalog: 0, propagate: 1, archive: 2, match: 3, done: 4 }

interface Line {
  message?: string
  start?: number
  end?: number
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "1 Nov 05:47" (UTC) */
const shortUtc = (ms: number) => {
  const d = new Date(ms)
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${fmtUtc(ms, false).split(' ')[1]}`
}
const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`

export function ComputingReadout({ onCancel }: { onCancel?: () => void }) {
  const place = useApp((st) => st.place)
  const mobile = useIsMobile()
  const rootRef = useRef<HTMLDivElement>(null)
  const [t0] = useState(() => performance.now())
  const [windowEnd] = useState(() => Date.now())
  const [now, setNow] = useState(t0)
  // Progress history lives in a ref, folded from a store subscription. The engine streams events from
  // worker messages (hundreds a second); rendering each one would be wasted work, so the 10 Hz clock
  // below is what repaints the readout.
  const hist = useRef<{ lines: Record<Stage, Line>; current: ProgressEvent['stage']; fraction: number; last?: ProgressEvent }>({
    lines: { catalog: {}, propagate: {}, archive: {}, match: {} },
    current: 'catalog',
    fraction: 0,
  })

  useExitClone(rootRef, {
    keyframes: [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateY(8px)' },
    ],
    duration: 420,
    easing: 'cubic-bezier(.2, 0, 0, 1)',
  })

  useEffect(() => {
    const fold = (e: ProgressEvent | undefined) => {
      const h = hist.current
      if (!e || e === h.last) return
      h.last = e
      const at = performance.now()
      const idx = ORDER[e.stage]
      h.current = e.stage
      for (const { stage } of STAGES) {
        const i = ORDER[stage]
        const l = h.lines[stage]
        if (i < idx) {
          l.start ??= at
          l.end ??= at
        } else if (i === idx) {
          l.start ??= at
          l.message = e.message
        }
      }
      if (e.fraction !== undefined) h.fraction = Math.max(h.fraction, e.fraction)
    }
    fold(useApp.getState().progress)
    const unsub = useApp.subscribe((st) => fold(st.progress))
    const id = window.setInterval(() => setNow(performance.now()), 100)
    return () => {
      unsub()
      window.clearInterval(id)
    }
  }, [])

  const { lines, current } = hist.current
  const progress = hist.current.last
  const elapsed = now - t0
  const fraction = progress?.stage === 'done' ? 1 : hist.current.fraction
  const curIdx = ORDER[current]
  const slow = elapsed > 7000 && curIdx >= 2
  const verySlow = elapsed > 16000 && curIdx >= 2
  const tz = place ? timeZoneAt(place.lat, place.lon) : undefined
  const cancel = onCancel ?? (() => useApp.getState().reset())
  const [d0, d1] = [shortUtc(windowEnd - 7 * 86_400_000), shortUtc(windowEnd)]

  return (
    // Not a live region itself: it repaints at 10 Hz. Only the stage change below is announced.
    <div ref={rootRef} className={s.root} role="region" aria-label="Computing passes">
      <p className="sr-only" role="status" aria-live="polite">
        {progress?.stage === 'done' ? 'Report ready' : `${STAGES[Math.min(curIdx, STAGES.length - 1)].idle}`}
      </p>
      <Rule className={s.rule}>
        <span className={s.ruleMain}>Computing</span>
        <span className={s.clock}>T+{secs(elapsed)}</span>
      </Rule>

      {place ? (
        <div className={s.place}>
          <h2 className={s.name}>{place.label}</h2>
          <div className={s.sub}>
            <ScrambleOnce text={`${fmtLat(place.lat)} ${fmtLon(place.lon)}`} className={s.coords} />
            {tz ? <span>{tz.replace(/_/g, ' ')}</span> : null}
            {place.sublabel ? <span>{place.sublabel}</span> : null}
          </div>
        </div>
      ) : null}

      <ol className={s.lines}>
        {STAGES.map(({ stage, tag, idle, done }, i) => {
          const l = lines[stage]
          const state = i < curIdx ? 'done' : i === curIdx ? 'run' : 'idle'
          const dur = l.start !== undefined ? (l.end ?? now) - l.start : undefined
          return (
            <li key={stage} className={cx(s.line, s[state])}>
              <span className={s.idx}>{pad2(i + 1)}</span>
              <span className={s.tag}>{tag}</span>
              <span className={s.msg}>{state === 'idle' ? idle : state === 'done' ? (l.message ?? done) : (l.message ?? idle)}</span>
              <span className={s.dur}>{dur !== undefined && state !== 'idle' ? secs(dur) : '—'}</span>
              <span className={s.status}>{state === 'done' ? 'OK' : state === 'run' ? <span className={s.caret} aria-hidden /> : ''}</span>
            </li>
          )
        })}
      </ol>

      <div className={s.bar} aria-hidden>
        <span className={s.fill} style={{ transform: `scaleX(${fraction.toFixed(4)})` }} />
        <span className={s.lead} style={{ left: `${(fraction * 100).toFixed(2)}%` }} />
      </div>
      <div className={s.foot}>
        <span>
          <span className={s.windowWord}>7-day window · </span>
          {d0} → {d1} UTC
        </span>
        <span className={s.pct}>{Math.round(fraction * 100)}%</span>
      </div>

      {slow ? (
        <p className={s.note}>
          {verySlow
            ? 'The image archives are slow to answer. If they don’t, the passes will still be shown from orbital geometry, and we’ll say so.'
            : 'Planetary Computer and NASA render on demand; this step can take a few seconds.'}
        </p>
      ) : null}

      <div className={s.actions}>
        <Button variant="ghost" size="sm" onClick={cancel} className={s.cancel}>
          Cancel {mobile ? null : <Kbd>Esc</Kbd>}
        </Button>
      </div>
    </div>
  )
}
