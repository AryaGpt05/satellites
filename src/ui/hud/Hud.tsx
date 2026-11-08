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
import { memo, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { timeZoneAt, tzReady } from '@/imagery'
import { subsolarPoint } from '@/lib/geo'
import { useApp } from '@/state/store'
import { Bezel, CornerReadout, Kbd, Reveal, ScrambleOnce, cx, fmtUtc, useWallSecondSync } from '@/ui/system'
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
 * The scene clock, when the globe isn't on live time (replay / scrub), at the place: the same clock and
 * date style as the pass header ("Scene Sun 1 Nov 11:21:13 EST"; phones drop the day so it clears the
 * top-left readout: "Scene 11:21:13 EST"). The zone always shows. UTC until the place's zone is known.
 * Its own subscriber: a replay at 60× changes the scene second every frame, and only this line should
 * re-render for it.
 */
function SceneTime() {
  const sceneSecond = useApp((st) => Math.floor(st.simTime / 1000))
  const lat = useApp((st) => st.place?.lat)
  const lon = useApp((st) => st.place?.lon)
  const ready = tzReady()
  const tz = useMemo(() => (lat !== undefined && lon !== undefined && ready ? timeZoneAt(lat, lon) : 'UTC'), [lat, lon, ready])
  const t = sceneSecond * 1000
  return (
    <span className={cx(s.line, s.dim)}>
      Scene
      <span className={s.sceneValue}>
        <span className={s.desk}>{fmtLocalDay(t, tz)} </span>
        {fmtLocalTime(t, tz, true)} {zoneAbbr(t, tz)}
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

  return (
    <div ref={rootRef} className={s.hud} data-scene={scene}>
      <Bezel />

      <CornerReadout corner="tl" label="Overflight" ref={topLeft}>
        <Reveal axis="x" duration={480} as="div" className={s.line}>
          <span className={s.wordmark}>Overflight</span>
          <span className={s.version}>{VERSION}</span>
        </Reveal>
        {onAbout ? (
          <Reveal axis="x" duration={480} delay={60} as="div" className={s.line}>
            <button type="button" className={s.about} onClick={() => aboutRef.current?.()} aria-keyshortcuts="?">
              <span className={s.aboutText}>How this works</span>
              <Kbd className={s.desk}>?</Kbd>
            </button>
          </Reveal>
        ) : null}
      </CornerReadout>

      <CornerReadout corner="tr" label="Time" ref={topRight}>
        <Reveal axis="x" duration={480} delay={80} as="div" className={s.line}>
          <span className={s.dot} aria-hidden data-blink />
          <UtcClock />
        </Reveal>
        {live ? null : <SceneTime />}
        {/* stacked: the sun joins the clock (bottom corners are hidden); a replay's scene time takes its place */}
        {live ? (
          <Reveal axis="x" duration={480} delay={120} as="div" className={cx(s.line, s.mob)}>
            <SunValue />
          </Reveal>
        ) : null}
      </CornerReadout>

      <CornerReadout corner="bl" label="Orbit catalog" className={s.wideOnly}>
        <Reveal axis="x" duration={480} delay={160} as="div" className={s.line}>
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
        <Reveal axis="x" duration={480} delay={220} as="div" className={cx(s.line, s.dim)}>
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
        <Reveal axis="x" duration={480} delay={240} as="div" className={s.line}>
          <SunValue scramble />
        </Reveal>
        <Reveal axis="x" duration={480} delay={300} as="div" className={cx(s.line, s.dim)}>
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
    publish()
    if (typeof ResizeObserver === 'undefined') return
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
