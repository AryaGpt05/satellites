/**
 * <BootScreen/>: phase 'boot'. An instrument start-up log of the real work the app is waiting on:
 *
 *   01 SOLAR EPHEMERIS   computed here (sub-solar point for the lighting), instant
 *   02 TYPEFACES         the three families, explicitly loaded so the hero never flashes a fallback
 *   03 ORBIT CATALOG     store.catalogReady (the controller loads it); shows the object count
 *   04 EARTH TEXTURES    store.globeReady (the globe sets it once first textures are on screen)
 *
 * Each line shows how long its step took (or is taking), and a status flag. Nothing is padded: the
 * screen leaves as soon as the controller moves to 'idle'. The exit is a mask wipe played on a clone
 * of the last frame (see useExitClone), so the landing underneath is live immediately.
 *
 * It sits just below the HUD (the bezel and corner readouts stay on top) and above the scene.
 */
import { useEffect, useRef, useState } from 'react'
import { subsolarPoint } from '@/lib/geo'
import { useApp } from '@/state/store'
import { Rule, cx, fmtInt, useExitClone } from '@/ui/system'
import { useCatalogStatus } from '@/ui/hud/catalogStatus'
import { fmtSun } from '@/ui/hud/readouts'
import s from './BootScreen.module.css'

type Flag = 'wait' | 'ok' | 'fail' | 'late'

interface Step {
  key: string
  name: string
  detail: string
  flag: Flag
  /** ms from boot start to completion; undefined while pending */
  took?: number
}

/** A step that has been pending this long is labelled as slow (honest, not alarming). */
const SLOW_MS = 5000

/** The three faces the first screen uses. Loading them explicitly makes them pending for fonts.ready too. */
const FONT_LOADS = ['500 16px "Instrument Sans Variable"', '400 16px "Martian Mono Variable"', 'italic 400 16px "Instrument Serif"']

function useFontsLoaded(t0: number) {
  const [state, setState] = useState<{ done: boolean; failed: boolean; took?: number; loaded: number }>(() => ({
    done: false,
    failed: false,
    loaded: 0,
  }))
  useEffect(() => {
    let alive = true
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts) {
      setState({ done: true, failed: false, took: 0, loaded: 0 })
      return
    }
    let loaded = 0
    const loads = FONT_LOADS.map((f) =>
      fonts.load(f).then((faces) => {
        if (faces.length) loaded++
        if (alive) setState((st) => ({ ...st, loaded }))
      }),
    )
    Promise.all(loads)
      .then(() => fonts.ready)
      .then(
        () => alive && setState({ done: true, failed: loaded < FONT_LOADS.length, took: performance.now() - t0, loaded }),
        () => alive && setState({ done: true, failed: true, took: performance.now() - t0, loaded }),
      )
    return () => {
      alive = false
    }
  }, [t0])
  return state
}

/** Record the first time a condition became true, relative to t0. */
function useTookWhen(cond: boolean, t0: number): number | undefined {
  const [took, setTook] = useState<number | undefined>(() => (cond ? 0 : undefined))
  useEffect(() => {
    if (cond && took === undefined) setTook(performance.now() - t0)
  }, [cond, took, t0])
  return took
}

export function BootScreen() {
  const [t0] = useState(() => performance.now())
  const [sun] = useState(() => ({ p: subsolarPoint(Date.now()), took: 0 }))
  const globeReady = useApp((st) => st.globeReady)
  const catalogReady = useApp((st) => st.catalogReady)
  const catalog = useCatalogStatus()
  const fonts = useFontsLoaded(t0)
  const globeTook = useTookWhen(globeReady, t0)
  const catalogTook = useTookWhen(catalogReady, t0)
  const elapsed = useElapsed(t0, !(globeReady && catalogReady && fonts.done))
  const rootRef = useRef<HTMLDivElement>(null)

  const pendingDetail = (base: string) => (elapsed > SLOW_MS ? 'Slow connection, still loading' : base)

  const steps: Step[] = [
    { key: 'sun', name: 'Solar ephemeris', detail: fmtSun(sun.p), flag: 'ok', took: sun.took },
    {
      key: 'fonts',
      name: 'Typefaces',
      detail: fonts.done ? (fonts.failed ? 'Using system fallbacks' : 'Sans · Mono · Serif') : `${fonts.loaded} / ${FONT_LOADS.length}`,
      flag: fonts.done ? (fonts.failed ? 'late' : 'ok') : 'wait',
      took: fonts.took,
    },
    {
      key: 'catalog',
      name: 'Orbit catalog',
      detail:
        catalog.state === 'error'
          ? 'Unavailable'
          : catalogReady && catalog.state === 'ready'
            ? `${fmtInt(catalog.count)} objects`
            : pendingDetail('CelesTrak GP elements'),
      flag: catalog.state === 'error' ? 'fail' : catalogReady ? 'ok' : 'wait',
      took: catalogTook,
    },
    {
      key: 'globe',
      name: 'Earth textures',
      detail: globeReady ? 'On screen' : pendingDetail('First light'),
      flag: globeReady ? 'ok' : 'wait',
      took: globeTook,
    },
  ]
  const done = steps.filter((x) => x.flag !== 'wait').length

  // The controller may flip to 'idle' in the same batch that completes the last step, so the final
  // React frame can still say WAIT. Fix the clone up from live state before it wipes away.
  // Exit: the log clears right-to-left (180 ms), then the ink curtain lifts top → bottom over the
  // globe while the landing (in the app layer above) runs its own entrance.
  useExitClone(rootRef, {
    keyframes: [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(100% 0 0 0)' }],
    duration: 720,
    delay: 160,
    easing: 'cubic-bezier(.6, 0, .2, 1)',
    onStart: (clone, reduced) => {
      if (reduced) return
      clone.querySelector<HTMLElement>('[data-block]')?.animate([{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(0 0 0 100%)' }], {
        duration: 180,
        easing: 'cubic-bezier(.6, 0, .2, 1)',
        fill: 'forwards',
      })
    },
    prepare: (clone) => {
      const st = useApp.getState()
      const ready: Record<string, boolean> = { sun: true, fonts: true, catalog: st.catalogReady, globe: st.globeReady }
      clone.querySelectorAll<HTMLElement>('[data-step]').forEach((row) => {
        const flag = row.querySelector<HTMLElement>('[data-flag]')
        if (!flag || flag.dataset.flag !== 'wait') return
        const next: Flag = ready[row.dataset.step ?? ''] ? 'ok' : 'late'
        flag.dataset.flag = next
        flag.textContent = FLAG_TEXT[next]
      })
      const bar = clone.querySelector<HTMLElement>('[data-progress]')
      if (bar) bar.style.transform = 'scaleX(1)'
      const count = clone.querySelector<HTMLElement>('[data-count]')
      if (count) count.textContent = `${steps.length} / ${steps.length}`
    },
  })

  return (
    <div ref={rootRef} className={s.boot} role="status" aria-live="polite" aria-label="Starting up">
      <div className={s.block} data-block>
        <div className={s.head}>
          <Rule index="00">Start-up</Rule>
          <span className={s.elapsed}>T+{(elapsed / 1000).toFixed(2).padStart(5, '0')} S</span>
        </div>
        <ol className={s.steps}>
          {steps.map((st, i) => (
            <li key={st.key} className={s.step} data-step={st.key} style={{ animationDelay: `${120 + i * 60}ms` }}>
              <span className={s.idx}>{String(i + 1).padStart(2, '0')}</span>
              <span className={s.name}>{st.name}</span>
              <span className={cx(s.detail, st.flag === 'fail' && s.warn)}>{st.detail}</span>
              <span className={s.took}>{st.took !== undefined ? `${(st.took / 1000).toFixed(2)} S` : ''}</span>
              <span className={s.flag} data-flag={st.flag}>
                {FLAG_TEXT[st.flag]}
              </span>
            </li>
          ))}
        </ol>
        <div className={s.foot}>
          <span className={s.bar} aria-hidden>
            <span className={s.barFill} data-progress style={{ transform: `scaleX(${done / steps.length})` }} />
          </span>
          <span className={s.count} data-count>
            {done} / {steps.length}
          </span>
        </div>
        {catalog.state === 'error' ? (
          <p className={s.note}>The orbit catalog could not be loaded. Check your connection and reload.</p>
        ) : null}
      </div>
    </div>
  )
}

const FLAG_TEXT: Record<Flag, string> = { wait: 'Wait', ok: 'OK', fail: 'Fail', late: 'Later' }

/** Milliseconds since t0, updated at ~10 Hz while `running`. */
function useElapsed(t0: number, running: boolean): number {
  const [ms, setMs] = useState(0)
  useEffect(() => {
    if (!running) {
      setMs(performance.now() - t0)
      return
    }
    const id = window.setInterval(() => setMs(performance.now() - t0), 100)
    return () => window.clearInterval(id)
  }, [t0, running])
  return ms
}
