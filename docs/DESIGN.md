# Overflight: design system

**The concept:** a precision instrument for a slightly uncanny question. It should feel like a JPL
mission console that a Swiss poster designer was allowed to art-direct. Every pixel has a job. Every
number is real. The emotion comes from what the data says, not from decoration.

> If a choice makes it look more like a SaaS landing page, a crypto dashboard, or a generic
> "AI-generated" sci-fi UI, it is the wrong choice.

---

## 1. Hard rules (anti-slop)

- **No** gradients used as decoration. No purple, no blue→pink, no neon glow on UI chrome.
- **No** glassmorphism. No `backdrop-filter: blur` panels. Panels are flat ink with hairline borders.
- **No** drop shadows on UI. Depth comes from hairlines, value contrast, and the 3D scene.
- **No** rounded cards. Border radius is `0` everywhere. The only exception is `2px` on tiny inputs, and only when needed.
- **No** emoji. **No** icon-library icons (no Lucide, Heroicons, or similar). All glyphs are custom 1px-stroke SVG drawn for this product (see `src/ui/system/Glyph.tsx`).
- **No** filler copy. No "Unlock insights", no "✨", no "Powered by AI". Copy is terse, declarative, and precise.
- **No** fake numbers. If a value is unknown, show `—`. Never pad with mock data in production paths.
- **No** generic loaders or spinners. Progress is shown as instrument readouts (text + hairline bar).
- **One signal colour.** Sodium orange means "an image of you exists" or "you are here". It is used rarely, so it reads loudly.

## 2. Colour

All colours are CSS variables in `src/styles/tokens.css`. Never hard-code hex values in components; three.js materials import `src/ui/system/palette.ts`.

| token | value | use |
|---|---|---|
| `--ink-0` | `#07080A` | page / space |
| `--ink-1` | `#0C0E11` | panels |
| `--ink-2` | `#14171C` | raised / hover |
| `--bone` | `#ECE8E0` | primary text, primary marks (warm off-white, never pure white) |
| `--bone-2` | `rgb(236 232 224 / .64)` | secondary text |
| `--bone-3` | `rgb(236 232 224 / .40)` | tertiary text, labels |
| `--bone-4` | `rgb(236 232 224 / .18)` | hairlines strong |
| `--line` | `rgb(236 232 224 / .10)` | hairlines default |
| `--signal` | `#FF6A1A` | sodium orange: photographed / you-are-here / primary action / live |
| `--signal-2` | `rgb(255 106 26 / .22)` | signal fills, swath ribbons |
| `--ice` | `#A9C7D3` | the ONLY secondary hue: radar + night-capable sensors, used sparingly |
| `--warn` | `#E8C547` | data caveats only (stale catalog, cloud cover) |

**Categories are encoded by mark form first and colour second:**
- `open-optical` with a real image: **signal**, solid filled diamond ◆
- `open-optical` with geometry only (likely): signal outline diamond ◇
- `commercial-optical`: bone outline square □
- `radar`: ice outline square with a centre dot
- `weather-leo`: bone circle outline ○
- `weather-geo`: bone ring with a tick ◎ (a constant presence, drawn as a band, not as events)
- `crewed`: bone plus ✛
- `other`: 1px bone-3 dot

## 3. Typography

Self-hosted via `@fontsource-variable/*`, imported in `src/styles/fonts.css`.

- **Display:** *Instrument Sans Variable* at `font-stretch: 75%` (condensed), weight 520–600, tracking `-0.02em`, leading `0.92`. Sentence case. Big: `clamp(44px, 7.2vw, 128px)`.
- **Body:** *Instrument Sans Variable* at `font-stretch: 100%`, weight 400, 15px/1.5. Secondary 13px.
- **Mono / data:** *Martian Mono Variable* at `font-stretch: 87.5%`, weight 300–400. Labels are 10.5px uppercase with tracking `+0.08em`. Readouts are 12–13px. Always `font-variant-numeric: tabular-nums`.
- **Serif accent:** *Instrument Serif* italic. At most **one** phrase per screen, for the human moment ("*you*.", "*this week*"). Never for UI.

Numbers are always mono. Units are smaller and in `--bone-3`: `786.2 KM`, `7.46 KM/S`, `98.6°`.

## 4. Layout

- The viewport is an **instrument bezel**: a hairline frame inset 16px (12px on mobile) with **corner tick marks** (8px L-shapes) and **edge rulers** (tiny ticks every 24px along the top edge, fading out at the centre). The 3D scene sits behind and bleeds past the frame.
- Fixed **corner readouts** in mono 10.5px (they hide on small screens if crowded):
  - TL: wordmark `OVERFLIGHT` plus version tag `v0.1 / BUILD 2026.11`
  - TR: live UTC clock `2026-11-08 03:31:07 UTC` with a blinking signal dot (1Hz, 50% duty, no fade)
  - BL: catalog status `12,847 OBJECTS · TLE EPOCH 2026-11-08 03:15Z · CELESTRAK`
  - BR: sub-solar point `SUN 12.4°S 118.2°E` plus scene FOV or camera altitude
- 12-column grid inside the bezel, 24px gutters, 32px outer margins on desktop. The content column for panels is 4 columns (≈ 420px) and docks right on desktop, as a bottom sheet on mobile.
- Hairline section rules have a **label notch**: a mono label sitting on the line, e.g. `── 02 / PASSES ─────────`.
- Generous negative space. The globe is the hero, so panels never cover more than 40% of the viewport on desktop.

## 5. Motion

- UI easing: `--ease-out: cubic-bezier(.2, 0, 0, 1)`; `--ease-in-out: cubic-bezier(.6, 0, .2, 1)`.
- Durations: `120ms` (hover), `240ms` (small), `480ms` (panels), `900ms` (hero text).
- **No bounce, no spring overshoot, no parallax gimmicks.** Precise and damped.
- Text reveal: line-by-line mask wipe (clip-path), 60ms stagger. Numbers count up with tabular digits over 600–900ms using ease-out.
- Code-like strings (NORAD IDs, coordinates) may do a brief **glyph scramble** (≤ 400ms), only on first appearance. Never on prose.
- Camera: moves take 2.4–3.6s with ease-in-out. Always ease the target and distance together, never a straight linear lerp. Respect `prefers-reduced-motion` with cuts and fades.
- **The signature moment, the pushbroom reveal:** when a captured image is shown, it is revealed **line by line in the satellite's along-track direction**, the way a pushbroom sensor actually builds an image. A 1px signal-coloured scan line leads the reveal with a faint trailing glow (6px, 30% to 0). Duration ≈ 1.6s. A mono readout beside it counts `LINE 0000 → 1024`.

## 6. The globe (3D art direction)

- **Photoreal but graded.** Day side slightly desaturated (–12%), cool-neutral. Oceans have a restrained specular glint from the real sun. A thin, accurate atmosphere rim (Rayleigh-ish, pale blue-white) is brighter on the day limb.
- **Night side:** city lights tinted toward sodium amber (`#FFB070`) so they rhyme with the signal colour. A soft warm **terminator band** marks the twilight line.
- **Clouds:** a separate layer at ~1.006R with a subtle shadow on the surface, slowly drifting.
- **Real sun position.** Lighting is computed from the actual date and time (see `src/lib/geo.ts`). The terminator you see is the real one, right now.
- **Stars:** sparse and dim, with a few magnitude classes and no twinkle. They rotate with GMST because they are inertial. No nebulae, no Milky Way skybox.
- **Satellites:**
  - Ambient catalog (~10k+): 1–1.5px points in `bone` at 35–55% alpha, with size attenuation. Starlink shells read as faint latitude bands.
  - Imaging satellites of interest: slightly larger points. Signal-coloured if they imaged the place.
  - The selected satellite has a **callout**: a leader line from the point to a label box drawn in screen space, in instrument style (hairline box, mono text, name plus altitude).
  - Orbits: 1px lines with alpha fading along the trail behind the satellite (no full ellipses by default).
- **Swath:** when a pass is selected, its **swath ribbon** is drawn on the surface as a translucent signal fill (`--signal-2`) with 1px edge lines, and the swath **sweeps** over the place marker in sync with replay time.
- **The place marker:** a signal-coloured crosshair reticle projected on the surface. It has a thin ring, four ticks, a centre dot, and a coordinate label. It locks in when the camera arrives (the ring contracts from 2× to 1× over 500ms).
- **Post:** very subtle film grain (≤ 3%), gentle vignette, mild bloom only on the signal colour and city lights. No chromatic aberration, no lens flare.

## 7. Voice

Declarative, specific, quietly uncanny. Second person. Real numbers.

- Hero: "Something photographed *you* this week." Sub: "Enter any place on Earth. See every satellite that passed over it in the last 7 days, and the actual pictures they took."
- Result headline: "In the last 7 days, **3 satellites photographed Waterloo.** 41 more passed within view."
- Pass detail: "Sentinel-2C crossed 786 km overhead at 16:14:21 UTC, moving south at 7.46 km/s. It was looking straight down. Cloud cover: 25%."
- Commercial: "WorldView Legion 4 passed within view at 10:52 local. It could have pointed here. We can't know whether it did."
- Geostationary: "GOES-19 has photographed this spot every 10 minutes, all week: 1,008 times."

Honesty is part of the aesthetic. Uncertainty is stated plainly in `--bone-3` mono footnotes.

## 8. Components (src/ui/system)

`Bezel`, `CornerReadout`, `Rule` (with notch label), `Label` (mono caps), `Readout` (label + value + unit), `Num` (tabular, count-up), `Button` (primary = signal fill + ink text, square; secondary = hairline), `Field` (search input: no box, just a baseline hairline that thickens on focus, with a blinking block caret), `Glyph` (custom SVG marks per category), `Scramble`, `Reveal` (mask wipe), `Tag` (mono, hairline box), `Sheet` (responsive panel: right dock on desktop, bottom sheet on mobile).

## 9. Accessibility and performance

- WCAG AA contrast for text (bone on ink passes easily, and bone-3 is used only for ≥ 10.5px mono labels).
- Keyboard: `/` focuses search, `←/→` steps through passes, `Esc` goes back, `Space` plays or pauses replay.
- `prefers-reduced-motion`: no scramble, no camera flights (cut plus 300ms fade), and the reveal becomes a fade.
- 60fps on an M1 Air at 1440p, and ≥ 40fps on a mid-range phone. DPR is capped at 2. Textures are progressive (2k first, then 8k).
