/** The production app (lazy-loaded so ?sandbox= pages never import unfinished modules). */
import { useEffect, useState } from 'react'
import { useApp } from '@/state/store'
import { GlobeCanvas } from '@/globe'
import { Hud } from '@/ui/hud'
import { BootScreen, Landing } from '@/ui/landing'
import { AboutPage } from '@/ui/pages'
import { ComputingReadout, ResultsView } from '@/ui/results'
import { boot, resetToLanding, runReport, writeUrl } from './controller'
import { ErrorNotice } from './ErrorNotice'
import s from './App.module.css'

export default function Main() {
  const phase = useApp((st) => st.phase)
  const error = useApp((st) => st.error)
  const [about, setAbout] = useState(false)

  useEffect(() => {
    void boot()
  }, [])

  // Keep ?p=<passId> in sync with the selection so links are always shareable.
  useEffect(
    () =>
      useApp.subscribe((st, prev) => {
        if (st.selectedPassId !== prev.selectedPassId && st.place && st.phase === 'results') writeUrl(st.place, st.selectedPassId)
      }),
    [],
  )

  // Global keys: Esc backs out, "?" opens About.
  useEffect(() => {
    // Overlays (About, ShareSheet, search suggestions) handle their own keys first and stop/prevent them.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || about) return
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable="true"]')
      if (e.key === 'Escape') {
        if (typing) return
        const st = useApp.getState()
        if (st.selectedPassId) return st.selectPass(undefined)
        if (st.phase === 'results' || st.phase === 'computing' || st.phase === 'error') resetToLanding()
      } else if (!typing && e.key === '?') {
        setAbout(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [about])

  return (
    <div className={s.root}>
      <GlobeCanvas className={s.scene} />
      <div className={s.layer}>
        {(phase === 'idle' || phase === 'locating') && <Landing onSubmit={(place) => void runReport(place)} />}
        {phase === 'computing' && <ComputingReadout onCancel={resetToLanding} />}
        {phase === 'results' && <ResultsView onBack={resetToLanding} />}
        {phase === 'error' && <ErrorNotice message={error} onBack={resetToLanding} />}
      </div>
      <Hud onAbout={() => setAbout(true)} />
      {phase === 'boot' && <BootScreen />}
      {about && <AboutPage onClose={() => setAbout(false)} />}
    </div>
  )
}
