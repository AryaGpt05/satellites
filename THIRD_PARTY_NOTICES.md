# Third-party notices

Watched's own source code is MIT-licensed (see [`LICENSE`](LICENSE)). This repository also contains, or ships at
run time, the third-party material below. Each keeps its own license; the attribution each one requires is given
here. npm dependencies are not vendored: their licenses travel with them in `node_modules` (see `package-lock.json`).

## Fonts

| Files | What | License | Requirement |
| --- | --- | --- | --- |
| `api/_fonts/display-*.ttf`, `api/_fonts/sans-*.ttf` | Instrument Sans, static instances | SIL OFL 1.1 | License text travels with the fonts: [`api/_fonts/OFL.txt`](api/_fonts/OFL.txt) |
| `api/_fonts/serif-italic-*.ttf` | Instrument Serif Italic, subsets | SIL OFL 1.1 | as above |
| `api/_fonts/mono-*.ttf` | Martian Mono, static instances | SIL OFL 1.1 | as above |
| (npm) `@fontsource*/instrument-sans`, `instrument-serif`, `martian-mono` | The same families, self-hosted in the web app | SIL OFL 1.1 | License ships in each package |

- Copyright 2022 The Instrument Sans Project Authors (https://github.com/Instrument/instrument-sans)
- Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif)
- Copyright 2021 The Martian Mono Project Authors (https://github.com/evilmartians/mono)

The `api/_fonts` files are Modified Versions (instanced and subset by `scripts/backend-fonts.py`) and are renamed
"Overflight Display / Sans / Serif / Mono". None of the original fonts declares a Reserved Font Name.

## Earth textures

| Files | Source | License | Requirement |
| --- | --- | --- | --- |
| `public/textures/earth-day-*.webp`, `earth-night-*.webp`, `earth-clouds-*.webp` | [Solar System Scope](https://www.solarsystemscope.com/textures/) 8k day, night and cloud maps (based on NASA Blue Marble / Black Marble imagery), resized and re-encoded by `scripts/build-textures.py` | CC BY 4.0 | Credit "Solar System Scope" and the license, and note the maps were modified |
| `public/textures/earth-data-*.webp` | `earth_bump_roughness_clouds_4096.jpg` from the three.js examples, itself Solar System Scope textures "resized and merged"; repacked by `scripts/build-textures.py` (bump + ocean mask) | CC BY 4.0 | as above |

Attribution: *Earth textures © [Solar System Scope](https://www.solarsystemscope.com/textures/), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); resized, re-encoded and channel-repacked for this project.*

## Satellite imagery

| Files | Source | License | Requirement |
| --- | --- | --- | --- |
| `api/_assets/og-default-plate.jpg` | Sentinel-2C L2A scene `S2C_MSIL2A_20261103T065031_R020_T40RCN_20261103T101659` (Palm Jumeirah, Dubai), cropped and toned, via Microsoft Planetary Computer | Copernicus Sentinel data terms (free, full and open) | "Contains modified Copernicus Sentinel data 2026" |
| `public/og-default.png` | The default share card, rendered by `api/og.tsx` from the plate above and the fonts above | as its parts | as above |

At run time the app also displays (it does not store in this repo) Sentinel-2 (Copernicus, as above), Landsat
(courtesy of the U.S. Geological Survey; public domain) and NASA GIBS / EOSDIS imagery (VIIRS, MODIS; NASA data is
not copyrighted, credit requested), GOES GeoColor (NOAA / CIRA) and Meteosat frames from EUMETSAT's map service
(EUMETView). Those frames are "Advanced Image Products", which EUMETSAT's Data Policy (as amended 25 November 2025)
lists as Core data, free and unrestricted, with the attribution of its article 6.3: "Contains modified EUMETSAT
Meteosat data" and the year. Credit for each appears in the app and README.

## Data

| Files | Source | License | Requirement |
| --- | --- | --- | --- |
| `public/data/catalog.json`, `public/data/catalog-names.json` | [CelesTrak](https://celestrak.org) GP element sets (refreshed by `.github/workflows/catalog.yml`) | Public data; CelesTrak asks for credit | Credit CelesTrak |
| `src/imagery/__fixtures__/pc-*.json`, `es-*.json` | Recorded STAC API responses (Planetary Computer, Element 84 Earth Search): metadata for Copernicus Sentinel-2 and USGS Landsat scenes, used only in tests | Copernicus / USGS open data terms | As above |
| `src/imagery/__fixtures__/photon-*.json` | Recorded [Photon](https://photon.komoot.io) geocoder responses (small OpenStreetMap extracts), used only in tests | ODbL 1.0 | "© OpenStreetMap contributors" |

## Brand

`public/brand/*.svg`, `public/favicon.svg` and the wordmark in `api/_lib/wordmark.ts` are original to this project.
They are covered by the MIT license as code, but the "Watched" name and wordmark identify the official site at
www.watched.earth: please don't use them to present a fork as the official site.
