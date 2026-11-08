# Watched

**Something watched you this week.**

Enter any place on Earth. Watched shows every satellite that passed over it in the last seven days, and the
actual pictures they took. It runs on a live 3D globe lit by the real sun, with all ~17,000 tracked objects in orbit.

→ **[www.watched.earth](https://www.watched.earth)**

---

## What it does

1. **Predicts every overflight.** It runs SGP4 over the public CelesTrak catalog for ~400 imaging, weather, radar and crewed
   satellites, and works out the exact moment each one's field of view crossed your spot during the past week. On a
   laptop this takes about half a second, in a pool of Web Workers.
2. **Finds the real photos.** It searches the Sentinel-2 and Landsat archives (Microsoft Planetary Computer, Element 84
   Earth Search) and NASA GIBS (VIIRS, MODIS, GOES) for the scenes those passes produced. Each scene is matched to a
   predicted pass and cropped around the place.
3. **Replays each pass.** The satellite flies its true ground track and its swath sweeps across your spot. The image
   then reveals line by line in the direction the satellite moved, the way a pushbroom sensor actually builds it.
4. **Stays honest.** "Photographed" only appears when a real image exists. Commercial satellites that *could* have
   pointed at you are labelled as such: their tasking is private, so the app can't know whether they did.

## Technical notes

- **A pass search that can't miss.** The angle between the satellite and the place changes no faster than a bound
  `ω_max`. The coarse march steps by `|θ − θ_field| / ω_max`, and a Lipschitz lower bound flags every interval that
  could reach the field. Golden-section search and bisection then refine closest approach, entry and exit to under a
  second. Checked against a one-second brute force: 0 missed passes in 22 adversarial cases (poles, antimeridian, a
  32 km swath).
  See [`src/engine/passes.ts`](src/engine/passes.ts).
- **17k satellites on the GPU.** The catalog is converted to mean Keplerian elements with J2/J4 secular drift.
  A vertex shader solves Kepler's equation for every object each frame. The worst LEO error is 17–24 km against full
  SGP4 over ±24 h, about a pixel at globe scale. See [`src/engine/elements.ts`](src/engine/elements.ts).
- **Real sun, real terminator.** The globe is Earth-fixed. The sun direction is computed from the actual date
  (Astronomical Almanac), and the stars rotate with sidereal time. Night lights, the terminator and ocean glint are
  all physically placed.
- **Archive time ≠ overpass time.** Sentinel-2's STAC `datetime` is the start of the datatake, often 5–10 minutes
  before the satellite crosses a given spot. Matching uses NORAD id plus a window, and all copy uses the predicted
  closest approach.
- **Share cards** are rendered on Vercel with `@vercel/og`: the real crop, a reticle on the exact spot, and the
  numbers. Supabase stores shares and coarse (~10 km) lookup counts through RPC-only functions. There is no direct
  table access, and exact locations are never stored.

## Stack

Vite · React 19 · TypeScript · three.js / @react-three/fiber · satellite.js (SGP4) · zustand · Vercel functions ·
Supabase (Postgres RPCs) · GitHub Actions (catalog refresh every 6 h)

```
src/engine    orbits, pass search (workers), capture matching, GPU element buffer
src/imagery   STAC + GIBS search, crops, cloud-at-the-spot checks, geocoding
src/globe     the 3D scene: Earth shader, atmosphere, clouds, satellites, swaths, camera director
src/ui        HUD, landing, results, timeline, pushbroom reveal, share
api/          OG share cards, share pages
supabase/     schema + RPCs
docs/         DESIGN.md (art direction), ARCHITECTURE.md (contracts)
```

## Develop

```bash
npm install
```

```bash
npm run dev
```

Copy `.env.example` to `.env.local` to enable shares and stats. The app works without it. Then:

```bash
npm test
```

## Data and credits

- Orbital data: [CelesTrak](https://celestrak.org) GP data, refreshed every six hours.
- Contains modified Copernicus Sentinel data [2026], processed by ESA, via Microsoft Planetary Computer and Element 84 Earth Search.
- Landsat imagery courtesy of the U.S. Geological Survey / NASA.
- Weather imagery: NASA GIBS / EOSDIS (VIIRS, MODIS), GOES GeoColor (NOAA / CIRA).
- Geocoding: [Photon](https://photon.komoot.io) · © OpenStreetMap contributors (ODbL).
- Earth textures: [Solar System Scope](https://www.solarsystemscope.com/textures/) (CC BY 4.0), based on NASA Blue Marble / Black Marble.

## Accuracy

Public element sets are good to roughly a kilometre near their epoch. Military and intelligence satellites aren't in
public catalogs. Scene cloud cover is reported by each archive, and the "cloud at your spot" check reads the
classification pixel at that point. Everything uncertain is labelled as such in the app.
