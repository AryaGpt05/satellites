/**
 * <Hud/>: the instrument chrome, always mounted above the globe (DESIGN §4).
 *
 *   TL  wordmark + version, About link            TR  live UTC clock, 1 Hz signal dot
 *   BL  catalog: objects, source, fetch time      BR  sub-solar point + GMST, every second
 *
 * Stacked layouts (and short landscape phones) would collide the bottom corners with the landing
 * panel and the bottom sheet, so those are hidden and the sun joins the top-right block.
 * When the scene is not showing live time (replay / scrub), the TR block adds the scene time, in the
 * place's own zone like every other time on the pass (the live clock stays UTC).
 *
 * Over a scene (results, a pass) functional ink scrims sit behind the readouts so they stay legible
 * over bright cloud (decision 5); the landing keeps the pure view. The HUD publishes the height it
 * covers at the top (store.uiInsets.top) so the camera frames below it.
 *
 * Only the leaves that show time re-render, and only when their text changes (UtcClock and GmstLine
 * every second, SunValue every ~24 s, CatalogAge every minute); the shell renders when the phase, the
 * catalog or the clock mode changes.
 */
import { memo, useLayoutEffect, useRef, type RefObject } from 'react'
import { timeZoneAt, tzReady } from '@/imagery'
import { subsolarPoint } from '@/lib/geo'
import { sceneClock, useSceneFrame } from '@/state/sceneClock'
import { useApp } from '@/state/store'
import { Bezel, CornerReadout, Kbd, Reveal, ScrambleOnce, cx, fmtUtc, useWallSecondSync, Wordmark } from '@/ui/system'
// The pure time module, never the lazy '@/ui/results' index (that would pull the results chunk in).
import { fmtLocalDay, fmtLocalTime, zoneAbbr } from '@/ui/results/lib/time'
import { useCatalogStatus } from './catalogStatus'
import { useSecondClock, useSecondDerived } from './clock'
import { fmtAge, fmtGmst, fmtObjects, fmtSource, fmtStampZ, fmtSun, isStale } from './readouts'
import s from './Hud.module.css'

export const VERSION = 'v0.1'

/** Space kept between the top readouts and what the camera frames below them. */
const TOP_GAP = 8

/**
 * After boot, the lines start wiping in this long after the loading screen starts to leave (src/app/bootCurtain.ts:
 * its wordmark glides 760 ms onto this one). The version and About lines wait for the logo to land (it passes
 * over their spot on its way in); the other corners start sooner.
 */
const AFTER_BOOT = 300

/**
 * The scene clock, when the globe isn't on live time (replay / scrub), at the place: the same clock and
 * date style as the pass header ("Scene Sun 1 Nov 11:21:13 EST"; phones drop the day so it clears the
 * top-left readout: "Scene 11:21:13 EST"). The zone always shows. UTC until the place's zone is known.
 *
 * Written straight into the DOM from the globe's per-frame clock (sceneClock), the one the replay
 * controls read, so its seconds turn on the same frame as theirs; text changes only when a second
 * does, and React never re-renders it for time (no 10 Hz store renders).
 */
function SceneTime() {
  const dayRef = useRef<HTMLSpanElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const last = useRef({ sec: NaN, key: '', tz: 'UTC', day: '', time: '' })
  const write = () => {
    const st = useApp.getState()
    const ms = sceneClock.mode === st.timeMode ? sceneClock.simTime : st.simTime
    const L = last.current
    const place = st.place
    const ready = tzReady()
    const key = place ? `${place.lat},${place.lon},${ready ? 1 : 0}` : ''
    const sec = Math.floor(ms / 1000)
    if (sec === L.sec && key === L.key) return
    if (key !== L.key) {
      L.key = key
      L.tz = place && ready ? timeZoneAt(place.lat, place.lon) : 'UTC'
    }
    L.sec = sec
    const t = sec * 1000
    const day = `${fmtLocalDay(t, L.tz)} `
    const time = `${fmtLocalTime(t, L.tz, true)} ${zoneAbbr(t, L.tz)}`
    if (day !== L.day && dayRef.current) dayRef.current.textContent = L.day = day
    if (time !== L.time && timeRef.current) timeRef.current.textContent = L.time = time
  }
  // First text before the first paint; then once per frame (a no-op unless the second turned).
  useLayoutEffect(write)
  useSceneFrame(write)
  return (
    <span className={cx(s.line, s.dim)}>
      Scene
      <span className={s.sceneValue}>
        <span ref={dayRef} className={s.desk} />
        <span ref={timeRef} />
      </span>
    </span>
  )
}

/** "2026-11-08 03:31:07 UTC" (the date is dropped on phones). */
function UtcClock() {
  const now = useSecondClock()
  const [date, time] = fmtUtc(now).split(' ')
  return (
    <time dateTime={new Date(now).toISOString()} className={s.clock}>
      <span className={cx(s.dim, s.desk)}>{date} </span>
      {time} UTC
    </time>
  )
}

const sunText = (now: number) => fmtSun(subsolarPoint(now))

/** "SUN 16.6°S 007.1°E" (re-renders when the text changes, ~every 24 s); scrambles once when `scramble` is set. */
function SunValue({ scramble }: { scramble?: boolean }) {
  const sun = useSecondDerived(sunText)
  return scramble ? <ScrambleOnce text={sun} delay={120} className={s.value} /> : <>{sun}</>
}

function GmstLine() {
  const now = useSecondClock()
  return <>GMST {fmtGmst(now)}</>
}

/** "Fetched 2026-11-08 03:34Z · 4 h ago" (warn-coloured once the catalog is stale; re-renders when the age text changes). */
function CatalogAge({ fetchedAt }: { fetchedAt: string }) {
  const key = useSecondDerived((now) => `${isStale(fetchedAt, now) ? 1 : 0}${fmtAge(Date.parse(fetchedAt), now)}`)
  const stale = key[0] === '1'
  return (
    <span className={stale ? s.warn : undefined}>
      Fetched {fmtStampZ(fetchedAt)}
      <span className={s.sep}>·</span>
      {stale ? 'Stale, ' : ''}
      {key.slice(1)} ago
    </span>
  )
}

/**
 * Memoised on whether there is an About action, not on its identity: the app re-renders (and passes a
 * fresh callback) for reasons that change nothing here. The latest callback is always the one called.
 */
export const Hud = memo(HudImpl, (a, b) => !!a.onAbout === !!b.onAbout)

function HudImpl({ onAbout }: { onAbout?: () => void }) {
  const aboutRef = useRef(onAbout)
  aboutRef.current = onAbout
  const live = useApp((st) => st.timeMode === 'live')
  const scene = useApp((st) => (st.selectedPassId ? 'pass' : st.phase === 'computing' || st.phase === 'results' ? 'results' : undefined))
  const catalog = useCatalogStatus()
  // Every blink in the chrome (the live dot, the pending cursor) is on for the first half of each UTC
  // second, the same frame the clock digits change.
  const rootRef = useRef<HTMLDivElement>(null)
  useWallSecondSync(rootRef)
  const topLeft = useRef<HTMLDivElement>(null)
  const topRight = useRef<HTMLDivElement>(null)
  useTopInset(topLeft, topRight)
  // The stacked sun line gives way to the scene time during a replay and comes back after it: its
  // wipe plays with the HUD's first entrance only, never again on its return (one entrance per element).
  // Set during the render that unmounts it, so its `skip` never changes while it is mounted.
  const sunReturns = useRef(false)
  if (!live) sunReturns.current = true
  // Under the loading screen the lines sit settled and unseen; when boot ends they remount (new key) and wipe in
  // while the loading screen's wordmark glides onto this one (bootCurtain), which is hidden until it lands.
  const booting = useApp((st) => st.phase === 'boot')
  const k = booting ? 'boot' : 'live'
  const at = (ms: number) => (booting ? 0 : AFTER_BOOT + ms)

  return (
    <div ref={rootRef} className={s.hud} data-scene={scene}>
      <Bezel />

      <CornerReadout corner="tl" label="Watched" ref={topLeft}>
        <div className={s.line}>
          <span className={s.mark} data-hud-wordmark>
            <Wordmark height={17} className={s.wordmark} />
          </span>
          <Reveal key={`${k}-version`} skip={booting} axis="x" duration={480} delay={at(440)} as="span" className={s.versionWrap}>
            <span className={s.version}>{VERSION}</span>
          </Reveal>
        </div>
        {onAbout ? (
          <Reveal key={`${k}-about`} skip={booting} axis="x" duration={480} delay={at(480)} as="div" className={s.line}>
            <button type="button" className={s.about} onClick={() => aboutRef.current?.()} aria-keyshortcuts="?">
              <span className={s.aboutText}>How this works</span>
              <Kbd className={s.desk}>?</Kbd>
            </button>
          </Reveal>
        ) : null}
      </CornerReadout>

      <CornerReadout corner="tr" label="Time" ref={topRight}>
        <Reveal key={`${k}-clock`} skip={booting} axis="x" duration={480} delay={at(0)} as="div" className={s.line}>
          <span className={s.dot} aria-hidden data-blink />
          <UtcClock />
        </Reveal>
        {live ? null : <SceneTime />}
        {/* stacked: the sun joins the clock (bottom corners are hidden); a replay's scene time takes its place */}
        {live ? (
          <Reveal key={`${k}-sun`} skip={booting || sunReturns.current} axis="x" duration={480} delay={at(60)} as="div" className={cx(s.line, s.mob)}>
            <SunValue />
          </Reveal>
        ) : null}
      </CornerReadout>

      <CornerReadout corner="bl" label="Orbit catalog" className={s.wideOnly}>
        <Reveal key={`${k}-objects`} skip={booting} axis="x" duration={480} delay={at(120)} as="div" className={s.line}>
          {catalog.state === 'ready' ? (
            <>
              <ScrambleOnce text={fmtObjects(catalog.count)} className={s.value} />
              <span className={s.sep}>·</span>
              {fmtSource(catalog.source)}
            </>
          ) : (
            <>
              <span className={s.value}>—</span> Objects
            </>
          )}
        </Reveal>
        <Reveal key={`${k}-age`} skip={booting} axis="x" duration={480} delay={at(180)} as="div" className={cx(s.line, s.dim)}>
          {catalog.state === 'ready' ? (
            <CatalogAge fetchedAt={catalog.fetchedAt} />
          ) : catalog.state === 'error' ? (
            <span className={s.warn}>Catalog unavailable</span>
          ) : (
            <span className={s.pending} data-blink>
              Loading catalog
            </span>
          )}
        </Reveal>
      </CornerReadout>

      <CornerReadout corner="br" label="Sun" className={s.wideOnly}>
        <Reveal key={`${k}-subsolar`} skip={booting} axis="x" duration={480} delay={at(200)} as="div" className={s.line}>
          <SunValue scramble={!booting} />
        </Reveal>
        <Reveal key={`${k}-gmst`} skip={booting} axis="x" duration={480} delay={at(260)} as="div" className={cx(s.line, s.dim)}>
          Sub-solar point<span className={s.sep}>·</span>
          <GmstLine />
        </Reveal>
      </CornerReadout>
    </div>
  )
}

/** Publish store.uiInsets.top = the lower of the two top readouts' bottoms + TOP_GAP. */
function useTopInset(topLeft: RefObject<HTMLDivElement | null>, topRight: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const tl = topLeft.current
    const tr = topRight.current
    const publish = () => {
      const b = Math.max(tl?.getBoundingClientRect().bottom ?? 0, tr?.getBoundingClientRect().bottom ?? 0)
      if (b > 0) useApp.getState().setUiInsets({ top: Math.ceil(b + TOP_GAP) })
    }
    if (typeof ResizeObserver === 'undefined') {
      publish()
      return
    }
    // The observer's first callback publishes (after layout, before paint): no forced layout at mount.
    const ro = new ResizeObserver(publish)
    if (tl) ro.observe(tl)
    if (tr) ro.observe(tr)
    window.addEventListener('resize', publish)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', publish)
    }
  }, [topLeft, topRight])
}
