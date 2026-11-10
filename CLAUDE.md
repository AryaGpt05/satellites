# Notes for Claude Code sessions

## Commits

- The owner is the **author** of every commit; Claude stays the **committer**. In each fresh clone, before the first
  commit:
  `git config author.name "dev-Armaan"` and `git config author.email "134523744+dev-Armaan@users.noreply.github.com"`.
  Leave `user.name` / `user.email` as the session set them (Claude): the session signs commits with Claude's key, and
  GitHub shows a commit as Verified only when the signing key belongs to the committer. Making the owner the committer
  too turns every commit Unverified (reason `unknown_key`). Claude also goes in a `Co-Authored-By:` trailer.
- Split work into many small commits, one per self-contained change (a fix, a feature's layer, its tests, its docs),
  each building and passing tests on its own, rather than one combined commit. Follow-up fixes get their own commits.
- `integration` is the working branch; a push to `main` deploys production. The catalog bot commits to `main`, so
  merge `origin/main` into `integration` before pushing `main`.

## Quirks that trip agents up

**Checks and style**
- `npm test` covers `src/**` only. The serverless functions in `api/` have their own suite: `npm run test:backend`.
  Run both, plus `npm run build` (it runs `tsc -b` and two Vite builds: the app and `/admin`).
- There is no Prettier or ESLint config. Never run `npx prettier`: it downloads Prettier and rewrites files in its
  defaults (double quotes, 80 columns). House style: single quotes, no semicolons, ~120 columns, and a doc comment at
  the top of each module saying *why* it works the way it does. Follow `docs/DESIGN.md` for UI: tokens only, no raw
  font sizes or colours.

**Production, data and permissions**
- Every branch push gets a Vercel preview deploy, behind Vercel login. To open one, use the Vercel connector's
  `get_access_to_vercel_url` (a share link) and keep its cookie.
- Supabase project `etiebfmgepkcewkkbxwi`: use the Management API
  (`POST https://api.supabase.com/v1/projects/etiebfmgepkcewkkbxwi/database/query`; the session proxy adds the token).
  Do NOT use the Supabase MCP connector: it points at an unrelated project (`xcinlndzgpzjmvmeujor`).
- There is no migration-history table. A migration is applied by running its file, and only after the owner says
  "apply 000N". Never run `supabase/tests/0004_*` against production (its DDL deadlocks against live traffic). Never
  delete real data, and never use a service-role or secret key; only the publishable key, which is public.
- Analytics props are allow-listed in SQL (`overflight_private.event_props`, latest definition in
  `supabase/migrations/0010_*`). A new enum value (a search source, an action) is silently stored as null until a
  migration adds it.
- Admin stats are precomputed every 5 minutes by pg_cron (`admin_stats_cache`, migration 0009). Admin times are US
  Eastern.
- `VITE_*` env vars are bundled into the browser. Server secrets (`CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET`) are only
  read in `api/`. Never print env values.
- Cloud sessions cannot delete GitHub branches, change repo settings or use GitHub GraphQL (`gh` REST only). The
  owner does those.

**Testing against the live site** (www.watched.earth)
- Any probe must block writes so it doesn't pollute analytics: requests matching `rpc/(create_share|record_lookup|log_events)`,
  `/api/e` and `/_vercel/insights`, plus any non-GET to watched.earth or Supabase. Also add `?noanalytics=1`.
  Planetary Computer's STAC search must NOT be blocked, or no photos load: it is a GET (no CORS preflight, see
  `src/imagery/stac.ts searchPage`) that falls back to a POST if the archive refuses the GET form.
- Time a search with User Timing marks: `performance.getEntriesByName('overflight:<name>')`, for `run-report`,
  `engine-partial`, `engine-final`, `hero-ready`, `set-report` and `results`.
- Results are a rolling 7-day window, so any place or scene picked for a test goes stale within days. Find current
  data first (Planetary Computer STAC). Its Landsat Level-2 archive lags a few days.
- Playwright: Chromium only (no WebKit in cloud containers). Use `--disable-3d-apis` for anything that doesn't need
  the globe. With the globe, use `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` at about
  1280×800: it runs at 2–3 fps, so animation, drift and timing results there are not representative. For a
  long-press, send `Input.dispatchTouchEvent` over CDP.
- Keep screenshots and scripts in the scratchpad, never in the repo.

**How the app is built** (read before changing these areas)
- Photos: every Sentinel-2 / Landsat crop is toned in the pixels worker (`src/imagery/pixels.ts`) before it is
  shown. Never put a Planetary Computer URL straight into an `<img>`. Photo URLs are canonical cache keys
  (`cardUrl` / `thumbUrl` / `hiResUrl` in `src/ui/results/lib/photos.ts`): a slightly different URL is a second
  download and a second decode. One `<img>` element per view, per photo (`images.ts`). Owner rule: a photo never
  reloads, re-fades or flickers.
- Planetary Computer renders every crop on demand (1–2 s, no cache on its side). The results screen deliberately
  waits for the final report and the hero photo before it appears (R-M1, `controller.ts showFirst`). Don't "speed it
  up" by painting earlier: the headline would change after it is shown.
- Globe: React Three Fiber with a manual camera (`cameraMath.ts` applies an off-axis lens shift). DOM labels follow
  scene points every frame through `runtime.anchors` and `anchorListeners`, never React state. The globe chunk is
  lazy and must not import `src/app/*`: pass callbacks in through `GlobeCanvas` props.
- Back button: layers register with `src/lib/backStack.ts`. Never call `history.pushState` directly.
- Global keys: Main's Esc handler respects `defaultPrevented`. An overlay that owns Esc listens in the capture phase
  and calls `preventDefault()`.
- iOS: tapping a non-input element blurs the focused field before `click` fires. Choose touch taps on `pointerup`
  (see `SearchBox.tsx`).
- Vercel functions use the fetch-style handler (`export default { fetch }`) and are registered in `vercel.json`
  (`maxDuration`). Vercel passes the query string percent-encoded in `req.url`.
- Honest labelling is a product rule: a label (resolution, "watched", counts) must say exactly what is on screen.
