/**
 * Orbit catalog: loads /data/catalog.json (CelesTrak GP mean elements, see scripts/fetch-catalog.ts),
 * resolves every object against the curated profiles, and hands out SGP4 records on demand.
 *
 * Off the main thread (decision #9, K4): the browser downloads the file on the main thread (so the
 * <link rel=preload> in index.html is reused), then transfers the bytes to a one-shot module worker
 * (elements.worker.ts) that parses the JSON, validates and resolves every row, AND packs the GPU element
 * buffer. It posts back a columnar `CatalogPayload` (typed arrays, transferred, plus three joined strings)
 * and the `ElementBuffer`. The main thread then only indexes NORAD ids; everything else is lazy:
 *   - SatInfo is built eagerly for the ~400 featured (profiled) rows, and on first `getSatInfo` /
 *     `byNorad.get` for any other object (hover labels). `cat.sats` materialises them all on first access.
 *   - CatalogRow arrays (for SGP4) are rebuilt from the columns on first `getRow`.
 *   - `buildElementBuffer(cat)` returns the worker's buffer at once.
 * Without workers (tests, CSP), the same code runs on the main thread (`ingestCatalog`).
 *
 * Rows that cannot possibly initialise (non-finite numbers, e ∉ [0,1), n ≤ 0) are dropped at load and
 * counted in `skipped`; a row whose SGP4 initialisation still fails is flagged the first time it is used
 * (sgp4.ts, which holds the satellite.js side so this module stays light for the first bundle).
 */
import type { CatalogFile, CatalogRow, SatCategory, SatInfo, SatProfile } from '@/types'
import { displayNameFor, PROFILES, resolveProfile } from './profiles'

export interface LoadedCatalog {
  fetchedAt: string
  source: string
  /** Usable objects (validated, deduplicated): the length of `sats`, without materialising it. */
  count: number
  /** Every object. Built on first access (the featured ones exist from the start). */
  readonly sats: SatInfo[]
  /** NORAD → SatInfo for every object; entries are built on demand. */
  byNorad: Map<number, SatInfo>
  /** Rows dropped at load because their elements are unusable. Not part of `sats`. */
  skipped: number
}

/** Field indices of a CatalogRow (see src/types.ts). */
export const ROW = {
  norad: 0,
  name: 1,
  intlDes: 2,
  epoch: 3,
  meanMotion: 4,
  ecc: 5,
  incl: 6,
  raan: 7,
  argp: 8,
  meanAnomaly: 9,
  bstar: 10,
  ndot: 11,
  nddot: 12,
} as const

/** Numeric columns of a row, in order: meanMotion … nddot (ROW indices 4…12). */
export const NUM_COLS = 9

/** Epoch of a row as epoch ms (UTC). CelesTrak epochs carry no zone suffix; they are UTC. */
export function rowEpochMs(r: CatalogRow): number {
  const iso = r[ROW.epoch]
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`)
}

// ───────────────────────────── file formats ─────────────────────────────

/**
 * The compact catalog file (v2, K11), written by scripts/fetch-catalog.ts. Columnar JSON, 40 % smaller
 * gzipped than v1 rows: NORAD ids delta-encoded, epochs as seconds after `fetchedAt` (10 ms), mean motion
 * to 1e-7 rev/day, no international designators, and names only for the profiled ("featured") objects.
 * Everyone else's name is in /data/catalog-names.json, loaded in idle time (`loadCatalogNames`).
 */
export interface CatalogFileV2 {
  v: 2
  fetchedAt: string
  source: string
  count: number
  /** NORAD ids, ascending, delta-encoded (first value absolute) */
  norad: number[]
  /** Element-set epoch, seconds after fetchedAt (negative = before) */
  epoch: number[]
  n: number[]
  e: number[]
  i: number[]
  raan: number[]
  argp: number[]
  ma: number[]
  bstar: number[]
  ndot: number[]
  nddot: number[]
  /** Names of profiled objects; '' for the rest */
  name: string[]
}

/** /data/catalog-names.json: every object's name, by NORAD id (delta-encoded, ascending). */
export interface CatalogNamesFile {
  fetchedAt: string
  norad: number[]
  name: string[]
}

export type AnyCatalogFile = CatalogFile | CatalogFileV2

const isV2 = (f: AnyCatalogFile): f is CatalogFileV2 => (f as CatalogFileV2).v === 2

/** Undo a delta encoding (first value absolute). */
export function undelta(xs: readonly number[]): number[] {
  const out = new Array<number>(xs.length)
  let acc = 0
  for (let i = 0; i < xs.length; i++) out[i] = acc += xs[i]
  return out
}

/** A v2 epoch offset → the ISO string satellite.js expects (UTC, no zone suffix, ms precision). */
function epochIso(fetchedAtMs: number, offsetS: number): string {
  return new Date(Math.round(fetchedAtMs + offsetS * 1000)).toISOString().slice(0, -1)
}

/** Rows of either file format (v2 is decoded to v1 rows: intlDes '' and, off-profile, name ''). */
export function catalogRows(file: AnyCatalogFile): CatalogRow[] {
  if (!isV2(file)) return file.rows
  const ids = undelta(file.norad)
  const t0 = Date.parse(file.fetchedAt)
  const rows = new Array<CatalogRow>(ids.length)
  for (let k = 0; k < ids.length; k++) {
    rows[k] = [ids[k], file.name[k] ?? '', '', epochIso(t0, file.epoch[k]), file.n[k], file.e[k], file.i[k], file.raan[k], file.argp[k], file.ma[k], file.bstar[k], file.ndot[k], file.nddot[k]]
  }
  return rows
}

/** True if a parsed JSON value looks like a catalog file of either format. */
export function isCatalogFile(v: unknown): v is AnyCatalogFile {
  const f = v as Partial<CatalogFile & CatalogFileV2> | null
  return !!f && typeof f === 'object' && typeof f.fetchedAt === 'string' && (Array.isArray(f.rows) || (f.v === 2 && Array.isArray(f.norad) && Array.isArray(f.epoch)))
}

function rowIsUsable(r: CatalogRow): boolean {
  if (!Array.isArray(r) || r.length < 13) return false
  if (!Number.isInteger(r[ROW.norad]) || typeof r[ROW.name] !== 'string') return false
  for (let i = 4; i <= 12; i++) if (!Number.isFinite(r[i])) return false
  const e = r[ROW.ecc]
  return r[ROW.meanMotion] > 0 && e >= 0 && e < 1 && Number.isFinite(rowEpochMs(r))
}

// ───────────────────────────── columnar form ─────────────────────────────

/** A catalog as columns: what the elements worker posts back (typed arrays are transferred). */
export interface CatalogPayload {
  fetchedAt: string
  source: string
  skipped: number
  count: number
  norad: Int32Array
  /** count × NUM_COLS: meanMotion, ecc, incl, raan, argp, meanAnomaly, bstar, ndot, nddot */
  num: Float64Array
  epochMs: Float64Array
  /** '\n'-joined columns (trimmed names; intlDes and epoch strings verbatim) */
  names: string
  intlDes: string
  epochs: string
  /** Index into PROFILES per row, −1 for none */
  profile: Int16Array
  /** Row indices whose category isn't 'other' (profiled satellites), in file order */
  featured: Int32Array
  /** The validated source rows, when the payload was built in this thread (never posted). */
  rows?: CatalogRow[]
}

const PROFILE_INDEX = new Map<SatProfile, number>(PROFILES.map((p, i) => [p, i]))
const oneLine = (s: unknown) => String(s ?? '').replace(/\n/g, ' ')

/** Validate, deduplicate and resolve a parsed catalog file into columns (the expensive part of loading). */
export function compactCatalog(input: AnyCatalogFile): CatalogPayload {
  const file = { fetchedAt: input.fetchedAt, source: input.source, rows: catalogRows(input) }
  const n = file.rows.length
  const norad = new Int32Array(n)
  const num = new Float64Array(n * NUM_COLS)
  const epochMs = new Float64Array(n)
  const profile = new Int16Array(n)
  const names: string[] = []
  const intlDes: string[] = []
  const epochs: string[] = []
  const featured: number[] = []
  const rows: CatalogRow[] = []
  const seen = new Set<number>()
  let k = 0
  let skipped = 0
  for (const r of file.rows) {
    if (!rowIsUsable(r) || seen.has(r[ROW.norad])) {
      skipped++
      continue
    }
    const id = r[ROW.norad]
    seen.add(id)
    const name = oneLine(r[ROW.name]).trim()
    const p = resolveProfile(id, name)
    norad[k] = id
    for (let c = 0; c < NUM_COLS; c++) num[k * NUM_COLS + c] = r[4 + c] as number
    epochMs[k] = rowEpochMs(r)
    profile[k] = p ? (PROFILE_INDEX.get(p) ?? -1) : -1
    if (p && p.category !== 'other') featured.push(k)
    names.push(name)
    intlDes.push(oneLine(r[ROW.intlDes]))
    epochs.push(oneLine(r[ROW.epoch]))
    rows.push(r)
    k++
  }
  return {
    fetchedAt: file.fetchedAt,
    source: file.source,
    skipped,
    count: k,
    norad: norad.slice(0, k),
    num: num.slice(0, k * NUM_COLS),
    epochMs: epochMs.slice(0, k),
    names: names.join('\n'),
    intlDes: intlDes.join('\n'),
    epochs: epochs.join('\n'),
    profile: profile.slice(0, k),
    featured: Int32Array.from(featured),
    rows,
  }
}

/** The typed arrays of a payload, for a postMessage transfer list. */
export function payloadTransfer(p: CatalogPayload): ArrayBuffer[] {
  return [p.norad.buffer, p.num.buffer, p.epochMs.buffer, p.profile.buffer, p.featured.buffer] as ArrayBuffer[]
}

/**
 * NORAD id → row index. The catalog script writes rows sorted by NORAD id, so this is a binary search over
 * the id column (no 17k-entry Map to build on the main thread: that alone was 18 ms on a 4× phone);
 * an unsorted file gets a Map, built on first use.
 */
class NoradIndex {
  private readonly sorted: boolean
  private map?: Map<number, number>
  constructor(private readonly ids: Int32Array) {
    let sorted = true
    for (let i = 1; i < ids.length && sorted; i++) sorted = ids[i] > ids[i - 1]
    this.sorted = sorted
  }
  get(norad: number): number | undefined {
    const ids = this.ids
    if (!this.sorted) {
      if (!this.map) {
        this.map = new Map()
        for (let i = 0; i < ids.length; i++) this.map.set(ids[i], i)
      }
      return this.map.get(norad)
    }
    let lo = 0
    let hi = ids.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const v = ids[mid]
      if (v === norad) return mid
      if (v < norad) lo = mid + 1
      else hi = mid - 1
    }
    return undefined
  }
  has(norad: number): boolean {
    return this.get(norad) !== undefined
  }
}

/** One installed catalog: its columns plus lazily built rows and SatInfo. */
class Store {
  readonly indexOf: NoradIndex
  private nameCol?: string[]
  private intlCol?: string[]
  private epochCol?: string[]
  private readonly infos: (SatInfo | undefined)[]
  private readonly rowCache: (CatalogRow | undefined)[]
  private all?: SatInfo[]
  private featuredInfos?: SatInfo[]

  constructor(readonly p: CatalogPayload) {
    this.indexOf = new NoradIndex(p.norad)
    this.infos = new Array(p.count)
    this.rowCache = p.rows ? p.rows : new Array(p.count)
  }

  private names(): string[] {
    return (this.nameCol ??= this.p.count ? this.p.names.split('\n') : [])
  }

  /** Whether any object still lacks a name (a v2 file before catalog-names.json). */
  missingNames(): boolean {
    return this.names().some((n) => !n)
  }

  profileAt(i: number): SatProfile | undefined {
    const k = this.p.profile[i]
    return k >= 0 ? PROFILES[k] : undefined
  }

  categoryAt(i: number): SatCategory {
    return this.profileAt(i)?.category ?? 'other'
  }

  info(i: number): SatInfo {
    let info = this.infos[i]
    if (!info) {
      const name = this.names()[i]
      const profile = this.profileAt(i)
      const norad = this.p.norad[i]
      // An off-profile object of a v2 file has no name until catalog-names.json arrives.
      info = { norad, name, displayName: name ? displayNameFor(name, profile) : `NORAD ${norad}`, category: profile?.category ?? 'other', profile }
      this.infos[i] = info
    }
    return info
  }

  /** Fill in names that the compact file left out (and patch SatInfo already handed out). */
  addNames(byNorad: Map<number, string>): number {
    const names = this.names()
    let filled = 0
    for (let i = 0; i < this.p.count; i++) {
      if (names[i]) continue
      const name = byNorad.get(this.p.norad[i])
      if (!name) continue
      names[i] = name
      filled++
      const info = this.infos[i]
      if (info) Object.assign(info, { name, displayName: displayNameFor(name, info.profile) })
      const row = this.rowCache[i]
      if (row) row[ROW.name] = name
    }
    return filled
  }

  row(i: number): CatalogRow {
    let r = this.rowCache[i]
    if (!r) {
      this.intlCol ??= this.p.intlDes.split('\n')
      this.epochCol ??= this.p.epochs.split('\n')
      const o = i * NUM_COLS
      const v = this.p.num
      r = [this.p.norad[i], this.names()[i], this.intlCol[i], this.epochCol[i], v[o], v[o + 1], v[o + 2], v[o + 3], v[o + 4], v[o + 5], v[o + 6], v[o + 7], v[o + 8]]
      this.rowCache[i] = r
    }
    return r
  }

  featured(): SatInfo[] {
    return (this.featuredInfos ??= Array.from(this.p.featured, (i) => this.info(i)))
  }

  sats(): SatInfo[] {
    if (!this.all) {
      const out = new Array<SatInfo>(this.p.count)
      for (let i = 0; i < this.p.count; i++) out[i] = this.info(i)
      this.all = out
    }
    return this.all
  }

  /** Build SatInfo for every row in small slices, yielding to the event loop between them. */
  async warm(slice = 2000): Promise<void> {
    for (let i = 0; i < this.p.count; i++) {
      this.info(i)
      if (i % slice === slice - 1) await yieldToMain()
    }
  }
}

/** scheduler.yield() where available (keeps the task's priority), else a macrotask. */
function yieldToMain(): Promise<void> {
  const sch = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (sch?.yield) return sch.yield()
  return new Promise((r) => setTimeout(r, 0))
}

/** A Map whose entries are built on demand from the store (iteration materialises them all). */
class InfoMap extends Map<number, SatInfo> {
  constructor(private readonly store: Store) {
    super()
  }
  override get(norad: number): SatInfo | undefined {
    const i = this.store.indexOf.get(norad)
    return i === undefined ? undefined : this.store.info(i)
  }
  override has(norad: number): boolean {
    return this.store.indexOf.has(norad)
  }
  override get size(): number {
    return this.store.p.count
  }
  private fill(): void {
    if (super.size === this.store.p.count) return
    for (const s of this.store.sats()) super.set(s.norad, s)
  }
  override forEach(cb: (value: SatInfo, key: number, map: Map<number, SatInfo>) => void, thisArg?: unknown): void {
    this.fill()
    super.forEach(cb, thisArg)
  }
  override entries(): MapIterator<[number, SatInfo]> {
    this.fill()
    return super.entries()
  }
  override keys(): MapIterator<number> {
    this.fill()
    return super.keys()
  }
  override values(): MapIterator<SatInfo> {
    this.fill()
    return super.values()
  }
  override [Symbol.iterator](): MapIterator<[number, SatInfo]> {
    return this.entries()
  }
}

// ───────────────────────────── singleton state ─────────────────────────────

let loaded: LoadedCatalog | undefined
let store: Store | undefined
let pending: Promise<LoadedCatalog> | undefined
const stores = new WeakMap<LoadedCatalog, Store>()
/** Bumped on every install, so caches keyed by NORAD id (sgp4.ts) know when to drop their entries. */
let generation = 0
export const catalogGeneration = () => generation

/**
 * Install a columnar catalog as the singleton (the worker path; `ingestCatalog` for parsed files).
 * Re-installing replaces the previous catalog and drops cached SGP4 records.
 */
export function installCatalog(p: CatalogPayload): LoadedCatalog {
  generation++
  const st = new Store(p)
  const cat: LoadedCatalog = {
    fetchedAt: p.fetchedAt,
    source: p.source,
    count: p.count,
    get sats() {
      return st.sats()
    },
    byNorad: new InfoMap(st),
    skipped: p.skipped,
  }
  st.featured() // eager: everything the report and the labels need first
  stores.set(cat, st)
  loaded = cat
  store = st
  pending = Promise.resolve(cat)
  return cat
}

/**
 * Install a parsed catalog file as the singleton (main-thread path; tests call it directly).
 * Re-ingesting replaces the previous catalog and drops cached SGP4 records.
 */
export function ingestCatalog(file: AnyCatalogFile): LoadedCatalog {
  return installCatalog(compactCatalog(file))
}

let namesLoad: Promise<number> | undefined

/**
 * Names for the objects a compact (v2) catalog lists without one (everything off-profile: debris, Starlinks…),
 * for hover labels. ~57 kB gz, fetched once in idle time; keyed by NORAD id, so a names file from an older
 * catalog still names nearly everything. Resolves with how many names were filled in (0 for a v1 catalog).
 * Never rejects.
 */
export function loadCatalogNames(url = '/data/catalog-names.json'): Promise<number> {
  const st = store
  if (!st || !st.missingNames()) return Promise.resolve(0)
  namesLoad ??= (async () => {
    try {
      const res = await fetch(url)
      if (!res.ok) return 0
      const f = (await res.json()) as CatalogNamesFile
      if (!f || !Array.isArray(f.norad) || !Array.isArray(f.name)) return 0
      const ids = undelta(f.norad)
      const map = new Map<number, string>()
      for (let k = 0; k < ids.length; k++) if (typeof f.name[k] === 'string' && f.name[k]) map.set(ids[k], f.name[k])
      return store ? store.addNames(map) : 0
    } catch {
      return 0
    } finally {
      namesLoad = undefined
    }
  })()
  return namesLoad
}

/** Each object of a catalog in file order: its NORAD id, row and category (no SatInfo built). */
export function forEachObject(cat: LoadedCatalog, fn: (norad: number, row: CatalogRow, category: SatCategory) => void): void {
  const st = stores.get(cat)
  if (!st) {
    for (const s of cat.sats) {
      const r = getRow(s.norad)
      if (r) fn(s.norad, r, s.category)
    }
    return
  }
  for (let i = 0; i < st.p.count; i++) fn(st.p.norad[i], st.row(i), st.categoryAt(i))
}

// ───────────────────────────── loading ─────────────────────────────

/** What the elements worker hands back: the catalog's columns and the GPU element buffer. */
export interface ParsedCatalog {
  payload: CatalogPayload
  elements?: import('./elements').ElementBuffer
}

/** Element buffers built off-thread, served by `buildElementBuffer(cat)` without recomputing. */
export const prebuiltElements = new WeakMap<LoadedCatalog, import('./elements').ElementBuffer>()

/**
 * Parse + resolve + pack in the elements worker. Resolves null when workers are unavailable or the
 * worker could not start (the caller falls back to the main thread); rejects on a malformed file.
 */
function parseInWorker(buf: ArrayBuffer): Promise<ParsedCatalog | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(null)
  return new Promise<ParsedCatalog | null>((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./elements.worker.ts', import.meta.url), { type: 'module', name: 'catalog' })
    } catch {
      resolve(null)
      return
    }
    const done = () => worker.terminate()
    worker.onmessage = (ev: MessageEvent<{ type: 'ok'; payload: CatalogPayload; elements: ParsedCatalog['elements'] } | { type: 'error'; message: string }>) => {
      done()
      const m = ev.data
      if (m.type === 'ok') resolve({ payload: m.payload, elements: m.elements })
      else reject(new Error(m.message))
    }
    worker.onerror = (ev) => {
      ev.preventDefault?.()
      done()
      resolve(null)
    }
    worker.onmessageerror = () => {
      done()
      resolve(null)
    }
    worker.postMessage({ type: 'parse', buf }, [buf])
  })
}

async function fetchCatalog(url: string): Promise<Response> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Catalog request failed: HTTP ${res.status}`)
  return res
}

function checkFile(file: unknown): AnyCatalogFile {
  if (!isCatalogFile(file)) throw new Error('Catalog file is malformed')
  return file
}

/**
 * Fetch and ingest the catalog once; concurrent and later calls share the same download.
 * `signal` only stops this caller's wait (rejecting with AbortError): the shared download carries on
 * for everyone else (the globe, the HUD, the next report), so one cancelled report can't break them.
 */
export function loadCatalog(url = '/data/catalog.json', signal?: AbortSignal): Promise<LoadedCatalog> {
  if (!pending) {
    const p = (async () => {
      const res = await fetchCatalog(url)
      if (typeof Worker !== 'undefined') {
        const parsed = await parseInWorker(await res.arrayBuffer())
        if (parsed) {
          const cat = installCatalog(parsed.payload)
          if (parsed.elements) prebuiltElements.set(cat, parsed.elements)
          // Hover labels for any object without a stall later: build the rest in idle slices.
          void store?.warm()
          return cat
        }
        // The worker couldn't start: the bytes went with it, so read the (HTTP-cached) file again.
        return ingestCatalog(checkFile(await (await fetchCatalog(url)).json()))
      }
      return ingestCatalog(checkFile(await res.json()))
    })()
    pending = p
    // A failed load must not poison the cache: the next call retries.
    p.catch(() => {
      if (pending === p) pending = undefined
    })
  }
  if (!signal) return pending
  if (signal.aborted) return Promise.reject(abortError())
  const shared = pending
  return new Promise<LoadedCatalog>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError')
}

/** The loaded catalog, if any (synchronous). */
export function currentCatalog(): LoadedCatalog | undefined {
  return loaded
}

export function getSatInfo(norad: number): SatInfo | undefined {
  return loaded?.byNorad.get(norad)
}

export function getRow(norad: number): CatalogRow | undefined {
  const i = store?.indexOf.get(norad)
  return i === undefined ? undefined : store!.row(i)
}

/** Satellites worth calling out (everything we have a profile for). */
export function featuredSats(cat: LoadedCatalog | undefined = loaded): SatInfo[] {
  if (!cat) return []
  const st = stores.get(cat)
  return st ? st.featured() : cat.sats.filter((s) => s.category !== 'other')
}
