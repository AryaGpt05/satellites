# Watched: architecture and module contracts

**Product:** enter a place → see every satellite that passed over it in the last 7 days, with the real
images they took. A 3D globe shows the real sun, the real catalog (~17k objects), and each pass replayed.

Stack: Vite 8 + React 19 + TypeScript 7 (`tsc -b`) + three.js 0.187 via @react-three/fiber 9 / drei 10 /
postprocessing. State: zustand (`src/state/store.ts`). Orbits: satellite.js 7 (SGP4). Hosting: Vercel
(static + `api/` functions). DB: Supabase (RPC-only access, publishable key).

Read first: `docs/DESIGN.md` (non-negotiable art direction), `src/types.ts` (shared contracts),
`src/lib/geo.ts` (frame conventions), `src/state/store.ts` (app state), `src/ui/system/*` (primitives).

## Data sources (all verified working, CORS `*`)

| what | endpoint | notes |
|---|---|---|
| Orbit catalog | `/data/catalog.json` (built by `.github/workflows/catalog.yml` from CelesTrak) | `CatalogFile` with `CatalogRow`s, ~16.9k rows, 2.4 MB (0.8 MB gz) |
| Sentinel-2 + Landsat search | `POST https://planetarycomputer.microsoft.com/api/stac/v1/search` | collections `sentinel-2-l2a`, `landsat-c2-l2`; `intersects` Point; `datetime` range; props `platform` (`Sentinel-2A/B/C`, `landsat-8/9`), `eo:cloud_cover`, `view:sun_elevation` |
| Crops (server-rendered PNG) | `GET https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/{minx},{miny},{maxx},{maxy}/{w}x{h}.png?collection=…&item=…&…` | S2: `assets=visual&asset_bidx=visual%7C1%2C2%2C3&nodata=0`. Landsat: `assets=red&assets=green&assets=blue&color_formula=gamma%20RGB%202.7,%20saturation%201.5,%20sigmoidal%20RGB%2015%200.55`. ~1–3 s |
| Point value (cloud at the spot) | `GET …/api/data/v1/item/point/{lon},{lat}?collection=sentinel-2-l2a&item=…&assets=SCL` | SCL classes 8, 9 = cloud, 10 = cirrus, 3 = cloud shadow |
| Fallback S2 search | `POST https://earth-search.aws.element84.com/v1/search`, collection `sentinel-2-c1-l2a` | assets `visual` = 8-bit RGB COG (range requests OK) |
| Weather imagery | NASA GIBS WMS `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS={layer}&STYLES=&FORMAT=image/jpeg&CRS=EPSG:4326&BBOX={minLat},{minLon},{maxLat},{maxLon}&WIDTH=&HEIGHT=&TIME={YYYY-MM-DD or ISO}` | layers: `VIIRS_NOAA20_CorrectedReflectance_TrueColor`, `VIIRS_NOAA21_…`, `VIIRS_SNPP_…`, `MODIS_Terra_…`, `MODIS_Aqua_…` (daily); `GOES-East_ABI_GeoColor`, `GOES-West_ABI_GeoColor` (10 min), `Himawari_AHI_Band3_Red_Visible_1km`. **Note the BBOX axis order for EPSG:4326 in WMS 1.3.0 is lat,lon** |
| Geocoding | `https://photon.komoot.io/api/?q=…&limit=6` and `/reverse?lat=&lon=` | GeoJSON; properties `name, city, state, country, countrycode, osm_value` |
| Time zone | `@photostructure/tz-lookup` (installed) | `tzlookup(lat, lon)` → IANA tz |

## Module ownership (parallel build: only touch files you own)

| module | owner dirs | key exports |
|---|---|---|
| **engine** | `src/engine/**`, `src/sandbox/engine.tsx` | catalog, profiles, propagation, passes, geostationary, report orchestration, GPU element buffer |
| **imagery** | `src/imagery/**`, `src/sandbox/imagery.tsx` | STAC + GIBS captures, crop URLs, spot cloud check, geocoding, tz |
| **globe** | `src/globe/**`, `src/sandbox/globe.tsx` | `<GlobeCanvas/>` and the whole 3D scene |
| **ui-shell** | `src/ui/hud/**`, `src/ui/landing/**`, `src/ui/pages/**`, `src/ui/system/**` (may ADD components), `src/sandbox/shell.tsx` | bezel, corner readouts, hero, search field, about page (the loading screen is index.html + `src/app/bootCurtain.ts`) |
| **ui-results** | `src/ui/results/**`, `src/ui/share/**`, `src/sandbox/results.tsx` | progress readout, results panel, timeline, pass list and detail, pushbroom reveal, share |
| **backend** | `api/**`, `supabase/**`, `vercel.json`, `src/lib/backend.ts` | DB schema and RPCs, OG share images, share pages, stats |
| integrator | `src/app/**`, `src/main.tsx`, `src/types.ts`, `src/state/**`, `src/lib/geo.ts`, `package.json`, `docs/**` | composition |

Rules for parallel work:
- Do not edit files outside your dirs. If you need a contract change (types, store, a new dependency), **do not make it**. Note it in your final report under "Integration requests" and code against a local adapter in your own dir in the meantime.
- Do not run `npm install`. All dependencies are already installed (see package.json).
- Do not use git (no commit, stash or checkout). The integrator commits.
- Typecheck only your files: `npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep "src/<yourdir>"` (others may be mid-edit).
- Dev server: `npx vite --port <your port> --strictPort` (engine 5181, imagery 5182, globe 5183, ui-shell 5184, ui-results 5185, backend 5186), and view `http://localhost:<port>/?sandbox=<name>`. Screenshots: Playwright is preinstalled (`require('playwright')`, `chromium.launch()` needs no options). WebGL in headless Chromium works with `args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']`.
- Your sandbox file must render your module standalone with realistic data (real API calls are fine), and must never be imported by production code.

## Contracts

### engine → `src/engine/index.ts`
```ts
export interface LoadedCatalog { fetchedAt: string; source: string; sats: SatInfo[]; byNorad: Map<number, SatInfo> }
export function loadCatalog(url?: string): Promise<LoadedCatalog>             // singleton, cached
export function getSatInfo(norad: number): SatInfo | undefined                  // after loadCatalog
export function propagate(norad: number, ms: number): SatState | null          // main-thread SGP4 for a handful of sats
export interface SatState { lat: number; lon: number; altKm: number; ecef: [number, number, number]; velKmS: number }
export function groundTrack(norad: number, t0: number, t1: number, stepS?: number): TrackPoint[]
export const CATEGORY_INDEX: Record<SatCategory, number>                      // stable small ints for GPU
export interface ElementBuffer {
  count: number
  refEpochMs: number            // shader time origin; pass uTime = (simTime - refEpochMs)/1000
  /** stride 12 floats per sat:
   * [0] a (world units, Earth radii)  [1] e  [2] i (rad)  [3] raan0 (rad)  [4] argp0 (rad)  [5] M0 (rad)
   * [6] n (rad/s)  [7] raanDot (rad/s, J2)  [8] argpDot (rad/s, J2)  [9] epochOffset (s, sat epoch − refEpoch)
   * [10] category index  [11] flags (bit0 = featured/interesting) */
  data: Float32Array
  norad: Int32Array
}
export function buildElementBuffer(cat: LoadedCatalog): ElementBuffer
export function computeReport(place: Place, opts?: ReportOptions): Promise<EngineReport>
// ReportOptions: days, now, signal, budgetMs, and the callbacks
//   onProgress(e)    progress events (many per frame: the controller writes one per frame)
//   onArchive(caps)  the Sentinel-2/Landsat scenes, as soon as the archive answers (the controller warms the likely hero)
//   onCover(c)       the clear cover (owner D), as soon as it is found; often before the partial report (R-M1)
//   onPartial(r)     everything but the GIBS mosaic matches; sent once more with its clearCover if that is found
//                    before the final report
//   onUpdate(r)      after the final report: background patches (GIBS stragglers, a late clear cover); counts only go up
// EngineReport = Report + notes, partial, timings, coverPending (the week needs a clear cover and it is still being
// checked: a later report carries it or says there is none) and finalDueAt (partial reports: when the final is due)
export function profileFor(norad: number): SatProfile | undefined
```
The shader must reproduce: ECI position from Kepler + J2 secular drift, then ECI → ECEF via GMST (`src/lib/geo.ts gmst`), then ECEF → world (`ecefToWorld`).
`computeReport` runs pass prediction in Web Worker(s) and calls the imagery module for captures. It must finish in **under 4 s** on a laptop for a 7-day window, streaming `ProgressEvent`s.
The pass-worker pool (`src/engine/pool.ts`) runs hardwareConcurrency − 1 workers, at most 4 on desktops and 2 on phones,
all from ONE fetch of the worker script (a build shares the self-contained bundle through a blob: URL; constructing N
module workers from the script's URL at once fetches it N times).

### imagery → `src/imagery/index.ts`
```ts
export function searchCaptures(place: LatLon, start: number, end: number, signal?: AbortSignal): Promise<Capture[]>   // S2 + Landsat (STAC)
export function weatherCaptures(place: LatLon, passes: Pass[], signal?: AbortSignal): Promise<Capture[]>             // GIBS daily VIIRS/MODIS for daytime weather-leo passes
export function geoImageUrl(collection: CaptureCollection, place: LatLon, ms: number, opts: { halfSizeKm: number; px: number }): string // GOES/Himawari frame at time
export function spotCloud(capture: Capture, place: LatLon, signal?: AbortSignal): Promise<'clear' | 'cloud' | 'shadow' | 'unknown'>
export function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]>
export function reversePlace(lat: number, lon: number, signal?: AbortSignal): Promise<Place>
export function locateMe(): Promise<LatLon>
export function timeZoneAt(lat: number, lon: number): string
export function preloadImage(url: string): Promise<HTMLImageElement>
```
`preloadImage` decodes off the main thread and caches by URL. Show the element it resolves with (or a clone): for a NASA
GIBS image its `src` is a blob: URL of the bytes the pixels worker fetched and checked for GIBS's all-black "no data"
answer (I-1: no full-size draw or read-back on the main thread), so a fresh `<img src={url}>` would download it again.

### globe → `src/globe/index.ts`
`export function GlobeCanvas(props: { className?: string }): JSX.Element`: a full-bleed canvas that reads the store. It renders:
Earth (real sun), clouds, atmosphere, stars, the whole catalog as GPU points, the place reticle, and the selected pass
(ground track, swath ribbon, satellite with callout, replay-synced), plus a camera director for `store.camera` intents.
Store writes: `globeReady`, `hoveredNorad`, `simTime`, `cameraFlight`, `dayMapSharp`. It sets `globeReady` once first textures are on screen, and
`dayMapSharp` once, when the first day-map upgrade above the boot level (2k on the phone tier, 4k on the desktop tier) has been
fully uploaded and swapped in, or at first light when the tier plan has no such step. `reset()` does not clear `dayMapSharp`.
It must also accept the engine's `ElementBuffer` (loaded internally via `loadCatalog` + `buildElementBuffer`).

### ui-shell → `src/ui/hud/index.ts`, `src/ui/landing/index.ts`, `src/ui/pages/index.ts`
`<Hud/>` (bezel plus corner readouts, always mounted; its lines enter when boot ends), `<Landing onSubmit={(place: Place) => void}/>` (phase `idle` / `locating`), `<AboutPage onClose/>`.

### The loading screen (integrator: `index.html`, `src/app/bootCurtain.ts`, `src/app/Main.tsx`)
The only loading screen is static HTML: `index.html`'s `#boot-static`, the serif wordmark centred on ink with a breathing
full stop, painted before any script runs (DESIGN §10). React never renders a boot screen. Contract:
- `<html data-boot>` is set in index.html and stays until the curtain lands. While it is there the HUD keeps its own
  wordmark (`[data-hud-wordmark]`) hidden (`visibility: hidden`), and its lines sit settled under the ink.
- Main calls `exitBootCurtain()` in the layout effect of the commit where the phase leaves `boot` (landing, computing
  panel, or fault notice), before that commit paints. It measures the HUD's wordmark and glides the centred one onto it
  (transform only, 760 ms), fades the ink (opacity, 120 → 680 ms), then in one task removes `data-boot` and
  `#boot-static`: the HUD's wordmark appears on the very pixels the glide landed on. Reduced motion: a 200 ms fade.
  If the HUD's wordmark can't be measured, it is shown at once and the centred one fades with the ink.
- `dropBootCurtain()` removes it immediately (dev sandboxes). Nothing may set the phase back to `boot` after it has
  left: a retry of the catalog (controller `retryCatalog`) loads it behind the fault notice instead.
- Boot leaves no sooner than 650 ms after navigation start and once the globe's first light and the first faces are
  in, waiting at most 12 s for them once the script runs (the script's own download comes first: measured on a 40 KB/s
  link, the wordmark held ~19 s, its "Slow connection" line from 6 s); deep and share links wait up to 1.2 s more for the sharp day map (R2K2).

### Overlays over the globe: `<html data-overlay>`
A full-screen overlay that covers the globe sets `document.documentElement.dataset.overlay` to `'lightbox'`, `'about'`
or `'share'` while it is open, and deletes it as soon as its close animation STARTS (so the globe renders a fresh frame
behind the exit). The globe owns the reader (R3-16): while the attribute is set it pauses (or drops to ≤ 2 fps), and it
renders a fresh frame in the same frame the attribute goes, with no stale frame or flash. Writers: the Lightbox, the
About page (it restores an earlier `'lightbox'` value on close), and the share sheet on stacked layouts only (the
desktop and landscape-phone share dialogs leave the globe visible around them, so they don't set it).

### ui-results → `src/ui/results/index.ts`, `src/ui/share/index.ts`
`<ComputingReadout/>` (phase `computing`; reads `store.progress`), `<ResultsView/>` (phase `results`; reads `store.report`; drives `selectPass`, `camera`, `timeMode`/`simTime` for replay), `<ShareSheet pass={Pass} report={Report} onClose/>`.

`prewarmResultsModel(report: Report): void`, exported from `src/ui/results/index.ts`: builds and caches the
`ResultsModel` for that `Report` object. The controller calls it in idle time, and only through a dynamic
`import('@/ui/results')` (never a static import, so the results chunk stays out of the boot bundle).

### backend
- `supabase/migrations/*.sql`: tables `lookups`, `shares`; RLS on, no direct anon table access; `security definer` RPCs `record_lookup`, `create_share`, `get_share`, `get_stats`.
- `src/lib/backend.ts`: browser client wrappers (`recordLookup`, `createShare`, `getShare`, `getStats`) using `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. These must **no-op gracefully** when env vars are missing.
- `api/og.tsx`: 1200×630 share card (`@vercel/og`) in the Instrument style. Runtime cards are returned as `image/jpeg`
  (under 250 KB; PNG decoded with `fast-png`, encoded with `jpeg-js`, both pure JS so `vercel.json` `includeFiles` is
  unchanged). `public/og-default.png` stays PNG. `api/s.ts`: share page HTML with OG tags that boots the app at `/?s=<id>`. `vercel.json`: rewrites `/s/:id` and caching headers.
- **Share fallback deep link** (used when a share row can't be created): `/?q=<lat>,<lon>&n=<label>&p=<passId>`, plus
  optional pass facts `sat`, `norad`, `verdict`, `t` (ms), `alt` (km), `off` (°), `hdg` (°), `collection`, `item`,
  `cloud` (%), `gsd` (m), `spot`. Coordinates are always rounded to 0.01°. `api/s.ts` unfurls it as the pass card.
  `controller.readUrlTarget` re-centres the 7-day window on `t` when `t` is more than 6 days old.

## App flow (integrator)
`boot` (the wordmark; textures, fonts; the catalog loads in parallel) → `idle` (hero + search over the spinning globe) → `locating` → `computing`
(camera flies to place; progress readouts) → `results` (panel + timeline; selecting a pass frames it and replays the
swath sweep; captured images reveal pushbroom-style) → share.
URL state: `/?q=<lat>,<lon>&n=<label>` deep-links straight to results; adding `&p=<passId>` and the optional pass facts
(`sat, norad, verdict, t, alt, off, hdg, collection, item, cloud, gsd, spot`; see the share fallback deep link under backend)
opens that pass; `/?s=<shareId>` opens a shared pass.
