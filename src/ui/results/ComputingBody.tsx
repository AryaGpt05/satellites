/**
 * The computing readout, as the BODY of the one results panel (decision #10: the panel persists from
 * computing to results; only its contents change). The header (COMPUTING · T+1.84 S / place) is the
 * OverviewHeader in computing mode.
 *
 *   01  CATALOG · 16,912 OBJECTS                0.21 S  OK
 *   02  PROPAGATING ORBITS · 1,203 / 2,410      1.10 S  ▮
 *   03  SENTINEL-2 + LANDSAT ARCHIVES             —
 *   04  MATCH SCENES TO PASSES                    —
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────  62%
 *
 * Reads `store.progress` (latest event only) through a subscription folded into a ref; a 10 Hz
 * clock repaints. Slow archives get an honest note after a few seconds. A shared link shows the
 * shared picture right away (R15), so the recipient sees it while their own report computes.
 */
import { useEffect, useRef, useState } from 'react'
import { gibsWmsUrl, pcCropUrl } from '@/imagery'
import { northInCropDeg } from '../../../api/_lib/toneRender'
import type { Share } from '@/lib/backend'
import { useApp } from '@/state/store'
import type { ProgressEvent } from '@/types'
import { shareCropUrl } from '@/ui/share'
import { cropSpec, displayUrl } from './lib/captures'
import { cx, fmtUtc } from '@/ui/system'
import { PushbroomReveal } from './PushbroomReveal'
import { markSeen } from './once'
import { fmtLocalDay, fmtLocalTime } from './lib/time'
import s from './ComputingReadout.module.css'

type Stage = Exclude<ProgressEvent['stage'], 'done'>
const STAGES: { stage: Stage; idle: string; done: string }[] = [
  { stage: 'catalog', idle: 'Orbital catalog', done: 'Catalog loaded' },
  { stage: 'propagate', idle: 'Propagate orbits · 7 days', done: 'Orbits propagated' },
  { stage: 'archive', idle: 'Sentinel-2 + Landsat archives', done: 'Archives searched' },
  { stage: 'match', idle: 'Match scenes to passes', done: 'Scenes matched' },
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
export const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`

export function ComputingBody({ t0, tz }: { t0: number; tz?: string }) {
  const pending = useApp((st) => st.pendingWindow)
  const shared = useApp((st) => st.shared)
  const [fallbackEnd] = useState(() => Date.now())
  const windowEnd = pending?.[1] ?? fallbackEnd
  const [now, setNow] = useState(() => performance.now())
  const [announce, setAnnounce] = useState('Computing passes')
  // Progress history lives in a ref, folded from a store subscription. The engine streams events from
  // worker messages (hundreds a second); rendering each one would be wasted work, so the 10 Hz clock
  // below is what repaints the readout.
  const hist = useRef<{ lines: Record<Stage, Line>; current: ProgressEvent['stage']; fraction: number; last?: ProgressEvent }>({
    lines: { catalog: {}, propagate: {}, archive: {}, match: {} },
    current: 'catalog',
    fraction: 0,
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
    // Once results land the readout freezes: a 10 Hz urgent re-render here would keep interrupting the
    // (transition) render of the results that replaces it.
    let id = 0
    const unsub = useApp.subscribe((st) => {
      fold(st.progress)
      if (st.phase !== 'computing' && id) {
        window.clearInterval(id)
        id = 0
      }
    })
    if (useApp.getState().phase === 'computing') id = window.setInterval(() => setNow(performance.now()), 100)
    // Screen readers hear the stage, at most once a second (the visual readout repaints at 10 Hz).
    let said = ''
    const sayId = window.setInterval(() => {
      const h = hist.current
      const text = h.current === 'done' ? 'Report ready' : STAGES[Math.min(ORDER[h.current], STAGES.length - 1)].idle
      if (text !== said) {
        said = text
        setAnnounce(text)
      }
    }, 1000)
    return () => {
      unsub()
      window.clearInterval(id)
      window.clearInterval(sayId)
    }
  }, [])

  const { lines, current } = hist.current
  const progress = hist.current.last
  const elapsed = now - t0
  const fraction = progress?.stage === 'done' ? 1 : hist.current.fraction
  const curIdx = ORDER[current]
  const slow = elapsed > 7000 && curIdx >= 2
  const verySlow = elapsed > 16000 && curIdx >= 2
  const [d0, d1] = [shortUtc(windowEnd - 7 * 86_400_000), shortUtc(windowEnd)]

  return (
    <div className={s.body} role="status" aria-live="polite">
      <p className="sr-only">{announce}</p>
      {shared ? <SharedPicture tz={tz} /> : null}
      <div aria-hidden className={s.readout} data-readout>
        <ol className={s.lines}>
          {STAGES.map(({ stage, idle, done }, i) => {
            const l = lines[stage]
            const state = i < curIdx ? 'done' : i === curIdx ? 'run' : 'idle'
            const dur = l.start !== undefined ? Math.max(0, (l.end ?? now) - l.start) : undefined
            return (
              <li key={stage} className={cx(s.line, s[state])}>
                <span className={s.idx}>{pad2(i + 1)}</span>
                <span className={s.msg}>{state === 'idle' ? idle : state === 'done' ? (l.message ?? done) : (l.message ?? idle)}</span>
                <span className={s.dur}>{dur !== undefined && state !== 'idle' ? secs(dur) : '—'}</span>
                <span className={s.status}>{state === 'done' ? 'OK' : state === 'run' ? <span className={s.caret} /> : ''}</span>
              </li>
            )
          })}
        </ol>

        <div className={s.bar}>
          <span className={s.fill} style={{ transform: `scaleX(${fraction.toFixed(4)})` }} />
          <span className={s.lead} style={{ transform: `translateX(${(fraction * 100).toFixed(2)}cqw)` }} />
        </div>
        <div className={s.foot}>
          <span>
            <span className={s.windowWord}>7-day window · </span>
            {d0} → {d1} UTC
          </span>
          <span className={s.pct}>{Math.round(fraction * 100)}%</span>
        </div>
      </div>

      {slow ? (
        <p className={s.note}>
          {verySlow
            ? 'The image archives are slow to answer. If they don’t, the passes will still be shown from orbital geometry, and we’ll say so.'
            : 'Planetary Computer and NASA render on demand; this step can take a few seconds.'}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The shared picture's crop URL: the share package's builder (SH1), or the same crop built here from
 * the share's archive item while that export is still a stub.
 */
function sharedImageUrl(share: Share): string | undefined {
  const fromShare = shareCropUrl(share)
  if (fromShare) return fromShare
  const c = share.capture
  if (!c) return undefined
  const at = { lat: share.lat, lon: share.lon }
  const spec = cropSpec(c.collection)
  if (c.collection === 'sentinel-2-l2a' || c.collection === 'landsat-c2-l2')
    return displayUrl({ cropUrl: (o) => pcCropUrl(c.collection as 'sentinel-2-l2a' | 'landsat-c2-l2', c.itemId, at, o) }, spec)
  const [layer, time] = c.itemId.split('@')
  return layer && time ? gibsWmsUrl(layer, time, at, spec) : undefined
}

/** A shared link's picture, shown at once while the recipient's own report computes. */
function SharedPicture({ tz }: { tz?: string }) {
  const shared = useApp((st) => st.shared)
  const itemId = shared?.capture?.itemId
  // PassDetail will not replay the reveal for this capture when the report lands.
  useEffect(() => {
    if (itemId) markSeen(`capture:${itemId}`)
  }, [itemId])
  if (!shared?.capture) return null
  // The pass view's own crop (R3-1: one URL per capture and size): when the recipient's report lands, the pass view
  // shows this very image, decoded already, from the one request.
  const url = sharedImageUrl(shared)
  if (!url) return null
  const name = shared.satName ?? 'A satellite'
  const t = shared.tClosest
  const when = t !== undefined && tz ? ` · ${fmtLocalDay(t, tz)}, ${fmtLocalTime(t, tz)}` : ''
  return (
    <div className={s.shared}>
      <PushbroomReveal
        src={url}
        view="shared"
        headingDeg={(shared.pass?.headingDeg ?? 180) + northInCropDeg(url)}
        lines={cropSpec(shared.capture.collection).px}
        alt={`${name} image of ${shared.placeLabel}, shared with you.`}
        startAt="now"
        frameClassName={s.sharedFrame}
      />
      <p className={s.sharedCaption}>
        <b>Shared with you</b> · {name} watched {shared.placeLabel}
        {when}
      </p>
    </div>
  )
}
