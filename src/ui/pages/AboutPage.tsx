/**
 * <AboutPage onClose/>: methodology, honesty and credits, as a full-height scrollable overlay in the
 * instrument language. A modal dialog: focus moves in and is trapped, Esc / the close control leave,
 * focus returns to where it was. The section index on the left tracks the reading position.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bezel, Glyph, Kbd, Reveal, cx, fmtInt, useExitClone, type GlyphName } from '@/ui/system'
import { VERSION } from '@/ui/hud/Hud'
import { useCatalogStatus } from '@/ui/hud/catalogStatus'
import { fmtStampZ } from '@/ui/hud/readouts'
import s from './AboutPage.module.css'

const SECTIONS = [
  { id: 'method', index: '01', title: 'How a pass is computed' },
  { id: 'words', index: '02', title: 'What the words mean' },
  { id: 'accuracy', index: '03', title: 'What we can’t see' },
  { id: 'privacy', index: '04', title: 'Privacy' },
  { id: 'credits', index: '05', title: 'Data and credits' },
  { id: 'keys', index: '06', title: 'Keys' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** Copernicus attribution year(s): the 7-day window can straddle New Year. */
function copernicusYears(now = Date.now()): string {
  const y1 = new Date(now).getUTCFullYear()
  const y0 = new Date(now - 7 * 86_400_000).getUTCFullYear()
  return y0 === y1 ? String(y1) : `${y0}–${y1}`
}

export function AboutPage({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [current, setCurrent] = useState<SectionId>('method')
  const catalog = useCatalogStatus()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Focus in on open, back out on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    // Focus the scrolling region (not the close button): no focus ring shouts on open, and the
    // arrow / Page keys scroll right away. Tab reaches the close button next.
    scrollRef.current?.focus({ preventScroll: true })
    return () => {
      if (prev && prev.isConnected) prev.focus({ preventScroll: true })
    }
  }, [])

  // A modal owns the keyboard. Listening on window in the capture phase, before anything else:
  //  - Esc and "?" close it (the app's own "?" toggle never sees the key);
  //  - Tab stays inside the dialog;
  //  - every other key stops here, so the app's shortcuts behind it (←/→ step passes, Space plays a
  //    replay, "/" searches) don't act on a screen you can't see. Default actions are untouched:
  //    Space, arrows and Page keys still scroll the page, Enter still presses a focused button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable="true"]')
      if (e.key === 'Escape' || (e.key === '?' && !typing)) {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') {
        e.stopPropagation()
        return
      }
      e.stopPropagation()
      if (!rootRef.current) return
      const focusables = [...rootRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
        (el) => el.offsetParent !== null,
      )
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (!rootRef.current.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Track which section is being read (the one crossing the upper third of the viewport).
  useEffect(() => {
    const root = scrollRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (hit) setCurrent(hit.target.id.replace('about-', '') as SectionId)
      },
      { root, rootMargin: '-20% 0px -70% 0px', threshold: 0 },
    )
    root.querySelectorAll('section[id^="about-"]').forEach((el) => io.observe(el))
    // The last sections can't reach the reading band: at the end of the page, the last one is current.
    const onScroll = () => {
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 8) setCurrent(SECTIONS[SECTIONS.length - 1].id)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      io.disconnect()
      root.removeEventListener('scroll', onScroll)
    }
  }, [])

  useExitClone(rootRef, {
    keyframes: [{ opacity: 1 }, { opacity: 0 }],
    duration: 240,
    easing: 'cubic-bezier(.2, 0, 0, 1)',
  })

  const jump = (id: SectionId) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`#about-${id}`)
    if (!el || !scrollRef.current) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    scrollRef.current.scrollTo({ top: el.offsetTop - 96, behavior: reduce ? 'auto' : 'smooth' })
  }

  const years = copernicusYears()

  return (
    <div ref={rootRef} className={s.overlay} role="dialog" aria-modal="true" aria-labelledby="about-title">
      <div ref={scrollRef} className={s.scroll} tabIndex={-1}>
        <header className={s.bar}>
          <span className={s.barLabel}>
            Overflight <span className={s.dim}>/ About</span>
          </span>
          <button ref={closeRef} type="button" className={s.close} onClick={onClose} aria-label="Close" aria-keyshortcuts="Escape">
            <span className={s.closeText}>Close</span>
            <Kbd className={s.closeKbd}>Esc</Kbd>
            <Glyph name="close" size={14} />
          </button>
        </header>

        <div className={s.grid}>
          <nav className={s.nav} aria-label="Sections">
            <ol>
              {SECTIONS.map((sec) => (
                <li key={sec.id}>
                  <button
                    type="button"
                    className={cx(s.navItem, current === sec.id && s.navCurrent)}
                    aria-current={current === sec.id ? 'location' : undefined}
                    onClick={() => jump(sec.id)}
                  >
                    <span className={s.navIdx}>{sec.index}</span>
                    {sec.title}
                  </button>
                </li>
              ))}
            </ol>
          </nav>

          <article className={s.article}>
            <header className={s.intro}>
              <h1 id="about-title" className={s.title}>
                <Reveal as="span" className={s.titleLine} delay={60}>
                  What this is,
                </Reveal>
                <Reveal as="span" className={s.titleLine} delay={120}>
                  and what it <em className={s.serif}>isn’t</em>.
                </Reveal>
              </h1>
              <Reveal as="p" className={s.lede} delay={260} duration={720}>
                Overflight replays the last seven days of orbits over a single point on Earth, then asks the public archives for
                the pictures. Every number is computed from public data, in your browser. Anything uncertain is labelled as such.
              </Reveal>
            </header>

            <Section id="method" index="01" title="How a pass is computed">
              <p>
                We start from the public catalog of orbital elements that{' '}
                <a href="https://celestrak.org/NORAD/elements/" target="_blank" rel="noreferrer">
                  CelesTrak
                </a>{' '}
                publishes from US Space Force tracking: General Perturbations (GP) mean elements for every active object.
                We refresh our copy every six hours.{' '}
                {catalog.state === 'ready' ? (
                  <>
                    The one this page loaded holds <span className={s.num}>{fmtInt(catalog.count)}</span> objects, fetched{' '}
                    <span className={s.num}>{fmtStampZ(catalog.fetchedAt)}</span>.
                  </>
                ) : null}
              </p>
              <p>
                For each satellite, the SGP4 propagator — the model those elements are fitted for — gives its position across the
                past week. We look for the moments the place fell inside what the satellite could see:
              </p>
              <Facts
                rows={[
                  ['Fixed swath', 'Pushbroom imagers see a fixed strip beneath them: about 290 km for Sentinel-2, 185 km for Landsat 8 and 9. The place has to fall inside it.'],
                  ['Field of regard', 'Agile commercial imagers can tilt, typically 30–45° off nadir. The place has to be within reach of that tilt.'],
                  ['Daylight', 'Optical cameras need the sun. We compute the sun’s elevation at the place for every pass; a pass in darkness is never counted as an optical photograph.'],
                  ['Geostationary', 'Weather satellites parked over the equator image the whole disk every 10 minutes or so. If the place is on their disk, it is in every frame.'],
                ]}
              />
              <p>
                Finally we search the archives — Microsoft Planetary Computer for Sentinel-2 and Landsat (with Element 84 Earth
                Search as a second source for Sentinel-2), NASA GIBS for weather imagery — and match real scenes to passes by
                platform and time. When we show a
                picture, it is that scene, cropped around the place.
              </p>
            </Section>

            <Section id="words" index="02" title="What the words mean">
              <Terms
                rows={[
                  ['imaged', 'Photographed', 'A real image of this place exists in a public archive, and you are looking at it.'],
                  ['likely', 'Likely imaged', 'Geometry and daylight say a fixed-swath imager covered the place, but no scene is published — not yet, or not kept because of cloud.'],
                  ['commercial', 'Passed within view', 'A commercial satellite could have pointed here. Their tasking is private: we can’t know whether it did, and we don’t pretend to.'],
                  ['crewed', 'Overhead', 'It passed over. Stations and everything else in the catalog.'],
                ]}
              />
            </Section>

            <Section id="accuracy" index="03" title="What we can’t see">
              <Facts
                rows={[
                  ['Element sets', 'Public elements are good to roughly a kilometre near their epoch and drift by a few kilometres a day after it. Pass times can be off by seconds, ground tracks by a few kilometres.'],
                  ['Classified', 'Military and intelligence satellites are largely absent from public catalogs, and none publish what they image. Some of the most capable cameras in orbit are invisible here.'],
                  ['Cloud', 'An image that exists may show only cloud. Where the archive allows, we read the cloud mask at the exact pixel over the place and say so.'],
                  ['Latency', 'Scenes reach the archives hours to days after capture, so the most recent passes may not have pictures yet.'],
                  ['Published figures', 'Swath widths and pointing limits are published specifications, not live tasking.'],
                ]}
              />
            </Section>

            <Section id="privacy" index="04" title="Privacy">
              <Facts
                rows={[
                  ['Computation', 'Orbits and passes are computed in your browser.'],
                  [
                    'What we store',
                    'To count how many places have been checked, each search stores a coarse grid cell about 10 km across, with its country and the nearest town’s name. Never your exact location.',
                  ],
                  ['Who else sees it', 'Place searches, and your position if you choose “Use my location”, go to the Photon geocoder (komoot) to find a name. Image requests go straight from your browser to the archives and include the area being shown.'],
                  [
                    'Shares',
                    'Only when you make one. A share link is public to anyone who has it: it holds the place name, its position rounded to about 1 km, and the pass you chose.',
                  ],
                ]}
              />
            </Section>

            <Section id="credits" index="05" title="Data and credits">
              <ul className={s.credits}>
                <Credit who="Copernicus Sentinel-2">Contains modified Copernicus Sentinel data {years}, processed by ESA. Served by Microsoft Planetary Computer and Element 84 Earth Search.</Credit>
                <Credit who="Landsat 8 / 9">Landsat imagery courtesy of the U.S. Geological Survey and NASA.</Credit>
                <Credit who="NASA GIBS / EOSDIS">VIIRS and MODIS imagery from NASA’s Global Imagery Browse Services, part of EOSDIS. GOES GeoColor via NOAA and CIRA; Himawari imagery via JMA.</Credit>
                <Credit who="Orbital data">General Perturbations element sets from CelesTrak. Propagation with satellite.js (SGP4).</Credit>
                <Credit who="Geocoding">Photon by komoot. Map data © OpenStreetMap contributors, available under the ODbL.</Credit>
                <Credit who="Earth textures">Day, night and cloud maps by Solar System Scope (CC BY 4.0), based on NASA Blue Marble and Black Marble imagery.</Credit>
                <Credit who="Type">Instrument Sans and Instrument Serif by Instrument; Martian Mono by Evil Martians. SIL Open Font License.</Credit>
              </ul>
            </Section>

            <Section id="keys" index="06" title="Keys">
              <dl className={s.keys}>
                <Key k={['/']}>Search for a place</Key>
                <Key k={['↑', '↓']}>Move through suggestions</Key>
                <Key k={['Enter']}>Choose</Key>
                <Key k={['←', '→']}>Step through passes</Key>
                <Key k={['Space']}>Play or pause the replay</Key>
                <Key k={['Esc']}>Back, or close</Key>
                <Key k={['?']}>This page</Key>
              </dl>
            </Section>

            <footer className={s.footer}>
              <span>
                Overflight <span className={s.ver}>{VERSION}</span>
              </span>
              <span className={s.dim}>Built on public data. Nothing here is a picture we took.</span>
            </footer>
          </article>
        </div>
      </div>
      <Bezel className={s.bezel} />
    </div>
  )
}

function Section({ id, index, title, children }: { id: SectionId; index: string; title: string; children: ReactNode }) {
  return (
    <section id={`about-${id}`} className={s.section} aria-labelledby={`about-${id}-h`}>
      <div className={s.secRule} aria-hidden>
        <span className={s.secIdx}>{index}</span>
      </div>
      <h2 id={`about-${id}-h`} className={s.h2}>
        {title}
      </h2>
      <div className={s.prose}>{children}</div>
    </section>
  )
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className={s.facts}>
      {rows.map(([k, v]) => (
        <div key={k} className={s.fact}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Terms({ rows }: { rows: [GlyphName, string, string][] }) {
  return (
    <dl className={s.terms}>
      {rows.map(([glyph, term, def]) => (
        <div key={term} className={s.term}>
          <dt>
            <span className={cx(s.termGlyph, glyph === 'imaged' && s.signal)}>
              <Glyph name={glyph} size={14} />
            </span>
            {term}
          </dt>
          <dd>{def}</dd>
        </div>
      ))}
    </dl>
  )
}

function Credit({ who, children }: { who: string; children: ReactNode }) {
  return (
    <li className={s.credit}>
      <span className={s.creditWho}>{who}</span>
      <span className={s.creditWhat}>{children}</span>
    </li>
  )
}

function Key({ k, children }: { k: string[]; children: ReactNode }) {
  return (
    <div className={s.key}>
      <dt>
        {k.map((x) => (
          <Kbd key={x}>{x}</Kbd>
        ))}
      </dt>
      <dd>{children}</dd>
    </div>
  )
}
