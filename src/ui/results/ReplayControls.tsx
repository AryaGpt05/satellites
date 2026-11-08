/**
 * Replay controls for the selected pass: play/pause (Space), rate, and a scrubber bounded to the pass
 * window. Scrubbing puts the clock in 'scrub' (the globe follows the store exactly); play resumes
 * 'replay' at the chosen rate (the globe advances it). The in-field window (when the place was inside
 * the swath / field of regard) is marked on the track, with a tick at closest approach.
 */
import { useId } from 'react'
import { useApp } from '@/state/store'
import type { Pass } from '@/types'
import { Glyph, Kbd, cx, fmtUtcTime, useIsMobile } from '@/ui/system'
import { seek, togglePlay } from './actions'
import { REPLAY_RATES, replayWindow, windowFraction } from './lib/replay'
import { fmtDuration, fmtTMinus } from './lib/time'
import s from './ReplayControls.module.css'

export function ReplayControls({ pass }: { pass: Pass }) {
  const id = useId()
  const timeMode = useApp((st) => st.timeMode)
  const simTime = useApp((st) => st.simTime)
  const rate = useApp((st) => st.replayRate)
  const w = replayWindow(pass)
  const playing = timeMode === 'replay'
  const inWindow = timeMode !== 'live' && simTime >= w[0] - 1000 && simTime <= w[1] + 1000
  const t = inWindow ? Math.min(w[1], Math.max(w[0], simTime)) : w[0]
  const pct = (x: number) => `${(windowFraction(x, w) * 100).toFixed(3)}%`
  const inField = pass.tEnd > pass.tStart
  const mobile = useIsMobile()

  return (
    <div className={s.root}>
      <div className={s.row}>
        <button
          type="button"
          className={cx(s.play, playing && s.playing)}
          onClick={() => togglePlay(pass)}
          aria-label={playing ? 'Pause replay' : 'Play replay'}
          aria-keyshortcuts="Space"
          data-space="play"
        >
          <Glyph name={playing ? 'pause' : 'play'} size={12} />
        </button>
        <div className={s.rates} role="radiogroup" aria-label="Replay speed">
          {REPLAY_RATES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={rate === r}
              className={cx(s.rate, rate === r && s.rateOn)}
              onClick={() => useApp.getState().setReplayRate(r)}
            >
              {r}×
            </button>
          ))}
        </div>
        <div className={s.clock} aria-live="off">
          <span className={s.tminus}>{fmtTMinus(t, pass.tClosest)}</span>
          <span className={s.utc}>{fmtUtcTime(t)} UTC</span>
        </div>
      </div>

      <div className={s.scrub}>
        <div className={s.track} aria-hidden>
          {inField ? <span className={s.field} style={{ left: pct(pass.tStart), width: `calc(${pct(pass.tEnd)} - ${pct(pass.tStart)})` }} /> : null}
          <span className={s.closest} style={{ left: pct(pass.tClosest) }} />
          <span className={s.progress} style={{ width: pct(t) }} />
          <span className={s.head} style={{ left: pct(t) }} />
        </div>
        <label htmlFor={id} className="sr-only">
          Scene time within the pass
        </label>
        <input
          id={id}
          type="range"
          className={s.range}
          min={w[0]}
          max={w[1]}
          step={1000}
          value={t}
          onChange={(e) => seek(Number(e.target.value))}
          aria-valuetext={`${fmtTMinus(t, pass.tClosest)}, ${fmtUtcTime(t)} UTC`}
        />
      </div>
      <div className={s.legend}>
        <span>{fmtUtcTime(w[0])}</span>
        <span className={s.legendMid}>
          {inField ? (
            <>
              <i className={s.fieldKey} /> In view {fmtDuration(pass.tEnd - pass.tStart)}
            </>
          ) : null}
          <i className={s.closestKey} /> Closest
        </span>
        <span>{fmtUtcTime(w[1])}</span>
      </div>
      {!mobile ? (
        <div className={s.keys}>
          <Kbd>Space</Kbd> play / pause
          <span className={s.keysGap} />
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> previous / next pass of this kind
        </div>
      ) : null}
    </div>
  )
}
