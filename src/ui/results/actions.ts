/**
 * Store intents issued by the results UI. One place, so the list, the timeline, the keyboard and the
 * detail actions all move the camera and the clock the same way.
 *
 *  focusPass   select + frame the pass + replay its swath sweep (ARCHITECTURE: "selecting a pass frames
 *              it and replays the swath sweep")
 *  clearPass   back to the overview: live time, camera on the place
 *  play/pause  replay ↔ scrub (scrub holds the exact frame; see globe/clock.ts)
 */
import { preloadImage } from '@/imagery'
import { useApp } from '@/state/store'
import type { Pass, Report } from '@/types'
import { captureFor, cropSpec, displayUrl } from './lib/captures'
import { DEFAULT_REPLAY_RATE, replayWindow } from './lib/replay'

/** Start decoding a pass's image early (PC renders take 1–3 s). Fire-and-forget. */
export function prefetchPassImage(report: Report | undefined, pass: Pass | undefined) {
  if (!report || !pass) return
  const c = captureFor(report, pass)
  if (!c) return
  preloadImage(displayUrl(c, cropSpec(c.collection))).catch(() => undefined)
}

export function startReplay(pass: Pass, rate = DEFAULT_REPLAY_RATE) {
  const st = useApp.getState()
  // Seed time before switching mode: the globe clock adopts the store's simTime on entering replay.
  st.setSimTime(replayWindow(pass)[0])
  st.setReplayRate(rate)
  st.setTimeMode('replay')
}

export function focusPass(pass: Pass) {
  const st = useApp.getState()
  prefetchPassImage(st.report, pass)
  st.selectPass(pass.id)
  st.setCamera({ kind: 'pass', passId: pass.id })
  startReplay(pass, st.timeMode === 'replay' || st.timeMode === 'scrub' ? st.replayRate : DEFAULT_REPLAY_RATE)
}

export function clearPass() {
  const st = useApp.getState()
  st.selectPass(undefined)
  st.setTimeMode('live')
  st.setSimTime(Date.now())
  if (st.place) st.setCamera({ kind: 'place', lat: st.place.lat, lon: st.place.lon })
}

export function togglePlay(pass: Pass) {
  const st = useApp.getState()
  const [a, b] = replayWindow(pass)
  if (st.timeMode === 'replay') {
    st.setTimeMode('scrub')
    return
  }
  // From the end (or outside the window), play restarts the pass.
  if (st.simTime >= b || st.simTime < a) st.setSimTime(a)
  st.setTimeMode('replay')
}

export function seek(t: number) {
  const st = useApp.getState()
  st.setTimeMode('scrub')
  st.setSimTime(t)
}
