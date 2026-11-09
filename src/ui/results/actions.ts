/**
 * Store intents issued by the results UI. One place, so the list, the timeline, the keyboard and the
 * detail actions all move the camera and the clock the same way.
 *
 *  focusPass   select + frame the pass + replay its swath sweep (ARCHITECTURE: "selecting a pass frames
 *              it and replays the swath sweep"). Reduced motion (decision #8): never auto-plays; the
 *              clock is parked at closest approach instead.
 *  selectQuietly  a gallery swipe (owner B): select + frame the pass, but no replay and no new reveal: the
 *              clock parks at closest approach (scrub), so the globe settles on the acquired view
 *  clearPass   back to the overview: live time, camera on the place
 *  play/pause  replay ↔ scrub (scrub holds the exact frame; see globe/clock.ts)
 */
import { useApp } from '@/state/store'
import { prefersReducedMotion } from '@/ui/system'
import type { Pass, Report } from '@/types'
import { warmPhoto } from './images'
import { captureFor } from './lib/captures'
import { cardUrl } from './lib/photos'
import { DEFAULT_REPLAY_RATE, replayWindow } from './lib/replay'

/**
 * Start decoding a pass's image early (PC renders take 1–3 s). Fire-and-forget. Through the results' own loader, so
 * the pass view's first frame finds it decoded (no ACQUIRING frame, no fade) from the one request (R3-1).
 */
export function prefetchPassImage(report: Report | undefined, pass: Pass | undefined) {
  if (!report || !pass) return
  const c = captureFor(report, pass)
  if (c) warmPhoto(cardUrl(c))
}

/**
 * Sim seconds of lead before closest approach, in real seconds at the replay rate: the swath reaches
 * the place ≈ 1.2 s after the replay starts, which is when the image's scan line crosses its centre
 * (arrival + 400 ms + half of the 1.6 s reveal). The globe holds the replay clock while flying.
 */
export const REPLAY_LEAD_S = 1.2

export function startReplay(pass: Pass, rate = DEFAULT_REPLAY_RATE) {
  const st = useApp.getState()
  const [a] = replayWindow(pass)
  // Seed time before switching mode: the globe clock adopts the store's simTime on entering replay.
  st.setSimTime(Math.max(a, pass.tClosest - REPLAY_LEAD_S * 1000 * rate))
  st.setReplayRate(rate)
  st.setTimeMode('replay')
}

export function focusPass(pass: Pass) {
  const st = useApp.getState()
  quiet.id = ''
  prefetchPassImage(st.report, pass)
  st.selectPass(pass.id)
  st.setCamera({ kind: 'pass', passId: pass.id })
  if (prefersReducedMotion()) {
    // Decision #8: no auto-starting replay. Park the scene at closest approach; Space / Play starts it.
    st.setTimeMode('scrub')
    st.setSimTime(pass.tClosest)
    return
  }
  startReplay(pass, st.timeMode === 'replay' || st.timeMode === 'scrub' ? st.replayRate : DEFAULT_REPLAY_RATE)
}

/** The last quiet selection (a gallery swipe): the phone two-beat sheet choreography skips it. */
export const quiet = { id: '' as string }

export function selectQuietly(pass: Pass) {
  const st = useApp.getState()
  if (st.selectedPassId === pass.id && st.camera.kind === 'pass' && st.camera.passId === pass.id) return
  quiet.id = pass.id
  // Time first: the globe's next frame sees scrub at closest approach together with the selection (no arming).
  st.setTimeMode('scrub')
  st.setSimTime(pass.tClosest)
  st.selectPass(pass.id)
  st.setCamera({ kind: 'pass', passId: pass.id })
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
