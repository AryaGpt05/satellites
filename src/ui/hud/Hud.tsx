/**
 * <Hud/>: the instrument chrome, always mounted above the globe (DESIGN §4).
 *
 *   TL  wordmark + version, About link            TR  live UTC clock, 1 Hz signal dot
 *   BL  catalog: objects, source, fetch time      BR  sub-solar point + GMST, every second
 *
 * On phones the bottom corners would collide with the landing copy and the bottom sheet, so they
 * are hidden and the two essentials (sun, clock) condense into the top-right block.
 * When the scene is not showing live time (replay / scrub), the TR block adds the scene time.
 */
import { useState } from 'react'
import { subsolarPoint } from '@/lib/geo'
import { useApp } from '@/state/store'
import { Bezel, CornerReadout, Kbd, Reveal, ScrambleOnce, cx, fmtUtc } from '@/ui/system'
import { useCatalogStatus } from './catalogStatus'
import { secondPhaseDelay, useSecondClock } from './clock'
import { fmtAge, fmtGmst, fmtObjects, fmtSource, fmtStampZ, fmtSun, isStale } from './readouts'
import s from './Hud.module.css'

export const VERSION = 'v0.1'

export function Hud({ onAbout }: { onAbout?: () => void }) {
  const now = useSecondClock()
  // Re-render on scene-time changes at 1 s resolution only, and only when not live.
  const sceneSecond = useApp((st) => (st.timeMode === 'live' ? 0 : Math.floor(st.simTime / 1000)))
  const catalog = useCatalogStatus()
  const [dotDelay] = useState(secondPhaseDelay)

  const utc = fmtUtc(now)
  const [date, time] = utc.split(' ')
  const sun = fmtSun(subsolarPoint(now))
  const stale = catalog.state === 'ready' && isStale(catalog.fetchedAt, now)

  return (
    <div className={s.hud}>
      <Bezel />

      <CornerReadout corner="tl" label="Overflight">
        <Reveal axis="x" duration={480} as="div" className={s.line}>
          <span className={s.wordmark}>Overflight</span>
          <span className={s.version}>{VERSION}</span>
        </Reveal>
        {onAbout ? (
          <Reveal axis="x" duration={480} delay={60} as="div" className={s.line}>
            <button type="button" className={s.about} onClick={onAbout} aria-keyshortcuts="?">
              How this works
              <Kbd className={s.desk}>?</Kbd>
            </button>
          </Reveal>
        ) : null}
      </CornerReadout>

      <CornerReadout corner="tr" label="Time">
        <Reveal axis="x" duration={480} delay={80} as="div" className={s.line}>
          <span className={s.dot} style={{ animationDelay: dotDelay }} aria-hidden />
          <time dateTime={new Date(now).toISOString()} className={s.clock}>
            <span className={cx(s.dim, s.desk)}>{date} </span>
            {time} UTC
          </time>
        </Reveal>
        {sceneSecond ? (
          <span className={cx(s.line, s.dim)}>
            Scene <span className={s.value}>{fmtUtc(sceneSecond * 1000)}</span>
          </span>
        ) : null}
        <span className={cx(s.line, s.mob)}>{sun}</span>
      </CornerReadout>

      <CornerReadout corner="bl" label="Orbit catalog" className={s.desk}>
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
            <span className={stale ? s.warn : undefined}>
              Fetched {fmtStampZ(catalog.fetchedAt)}
              <span className={s.sep}>·</span>
              {stale ? 'Stale, ' : ''}
              {fmtAge(Date.parse(catalog.fetchedAt), now)} ago
            </span>
          ) : catalog.state === 'error' ? (
            <span className={s.warn}>Catalog unavailable</span>
          ) : (
            <span className={s.pending}>Loading catalog</span>
          )}
        </Reveal>
      </CornerReadout>

      <CornerReadout corner="br" label="Sun" className={s.desk}>
        <Reveal axis="x" duration={480} delay={240} as="div" className={s.line}>
          <ScrambleOnce text={sun} delay={120} className={s.value} />
        </Reveal>
        <Reveal axis="x" duration={480} delay={300} as="div" className={cx(s.line, s.dim)}>
          Sub-solar point<span className={s.sep}>·</span>GMST {fmtGmst(now)}
        </Reveal>
      </CornerReadout>
    </div>
  )
}
