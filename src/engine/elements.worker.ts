/// <reference lib="webworker" />
/**
 * One-shot catalog worker (K4, decision #9): the heaviest pure work of a page load, off the main thread.
 *
 *   in:  { type: 'parse', buf }  the raw bytes of /data/catalog.json (transferred, zero-copy)
 *   out: { type: 'ok', payload, elements }  the columnar catalog (catalog.ts CatalogPayload) and the GPU
 *        element buffer (elements.ts), every typed array transferred
 *        { type: 'error', message }  a malformed file
 *
 * JSON.parse (~70 ms on a 4×-throttled phone), row validation, profile resolution and epoch parsing
 * (~80 ms) and buildElementBuffer (~170 ms, SGP4 re-anchoring of the drag-affected objects) all run here.
 */
import { compactCatalog, installCatalog, isCatalogFile, payloadTransfer } from './catalog'
import { buildElementBuffer } from './elements'

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (ev: MessageEvent<{ type: 'parse'; buf: ArrayBuffer }>) => {
  if (ev.data?.type !== 'parse') return
  try {
    const file: unknown = JSON.parse(new TextDecoder().decode(ev.data.buf))
    if (!isCatalogFile(file)) throw new Error('Catalog file is malformed')
    const payload = compactCatalog(file)
    const elements = buildElementBuffer(installCatalog(payload))
    // The source rows stay here: the main thread rebuilds the few it needs from the columns.
    const { rows: _rows, ...wire } = payload
    ctx.postMessage({ type: 'ok', payload: wire, elements }, [...payloadTransfer(payload), elements.data.buffer as ArrayBuffer, elements.norad.buffer as ArrayBuffer])
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
