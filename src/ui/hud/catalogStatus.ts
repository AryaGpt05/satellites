/**
 * Catalog status for the BL readout, through the engine's singleton loader (`loadCatalog` shares one
 * request with the app controller, so this costs nothing extra). This file is the only place the HUD
 * touches the engine.
 */
import { useEffect, useState } from 'react'
import { currentCatalog, loadCatalog, type LoadedCatalog } from '@/engine'
import { useApp } from '@/state/store'

export type CatalogStatus =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; count: number; fetchedAt: string; source: string }

const ready = (c: LoadedCatalog): CatalogStatus => ({ state: 'ready', count: c.sats.length, fetchedAt: c.fetchedAt, source: c.source })

export function useCatalogStatus(): CatalogStatus {
  const catalogReady = useApp((s) => s.catalogReady)
  const [status, setStatus] = useState<CatalogStatus>(() => {
    const c = currentCatalog()
    return c ? ready(c) : { state: 'loading' }
  })
  useEffect(() => {
    let alive = true
    loadCatalog().then(
      (c) => alive && setStatus(ready(c)),
      () => alive && setStatus({ state: 'error' }),
    )
    return () => {
      alive = false
    }
    // Retry when the app reports the catalog ready (e.g. after a failed first load).
  }, [catalogReady])
  return status
}
