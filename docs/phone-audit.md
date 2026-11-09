# Phone UX audit (read-only, Phase A)

Walked on `integration` @ a448a2e. Chromium with an iOS approximation:
- 440×956 @3 iPhone 16 Pro Max user agent, `isMobile`, `hasTouch`;
- Apple-like WebGL (OES_texture_float_linear and EXT_float_blend dropped; renderer reports "Apple GPU").

Plus Playwright's iPhone SE (375×667), iPhone 14 (390×844), iPhone 14 Pro Max (430×932), Pixel 7 (412×915) and iPhone 14 landscape (844×390).

**Flows covered:**
- landing → focus search → type → suggestions → simulated keyboard → pick;
- results → open a pass → lightbox → browser back;
- About;
- share sheet;
- Locate me (London);
- the end of the chips row.

**What I could not emulate:**
- WebKit itself, which isn't installed;
- real safe-area insets (Chromium reports 0);
- iOS keyboard behaviour (Chromium shrinks the layout viewport; iOS shrinks only the visual viewport);
- the in-app browser's toolbar collapse (approximated by resizing the viewport by 83 px);
- real GPU timing, which makes the long-task numbers from these parallel SwiftShader runs meaningless. They get re-measured on a production build in Phase B.

## Measured (all six sizes)

| | result |
|---|---|
| Horizontal scroll | none at any size or step |
| CLS | max 0.0017 (430×932, results arrival); all < 0.01 |
| Text clipped | "Share this pass" button label at 375 ("SHARE THIS PAS"); "6 MATCH…" readout at 390 with keyboard |
| Duplicate image URLs | none in the results flow (the 1k Earth maps are requested twice in dev: index.html preload + TextureLoader; to re-check on the production build) |

## Ranked fix list

### P0: broken or leaves the site

1. **Back gesture / browser back leaves the site from every layer.** Nothing calls `history.pushState`, only `replaceState`, and the probe went straight to `about:blank` from the pass view, the lightbox, About and the share sheet. The fix:
   - push an entry when opening a pass, the lightbox, About and the share sheet (and the search focus mode);
   - on `popstate`, close the top layer;
   - closing via UI pops the entry (`history.back()`) so the stack stays balanced;
   - a deep link or share link lands with a synthetic base entry, so back from its pass goes to its results, not off-site.
2. **375×667 pass view:** the "SHARE THIS PASS" label is clipped ("SHARE THIS PAS"), and the play/pause control and scrubber are half under the bottom action bar. The bar needs to shrink to an icon + "Share" at narrow widths, and the sheet's collapsed snap needs to clear the bar.
3. **Landscape (844×390):**
   - On the landing page, the hero, search field and chips sit **on top of the globe** ("Search a place" is drawn over Africa), so neither reads.
   - In the pass view the sheet shows only "← All passes" plus the action bar. The pass title, scrubber and photos are unreachable without dragging, and the globe's target ring is cut by the sheet.
   - With the keyboard open, "6 MATCHES" overprints the HUD clock and only about 1.5 suggestions show.

### P1: hard to navigate or close

4. **Search focus mode has no visible way out while the field is empty.** The × appears only once there's text. It needs a "Cancel" text button next to the field (always shown in focus mode), plus back-gesture support from item 1.
5. **The example chips run off the right edge** with no affordance (two of five are hidden at 440, four of five at 375; after scrolling, the first chip is cut at the left bezel). Wrap them onto two rows on phones so all five are visible. They're also only **40 px tall**: make them ≥ 44.
6. **Two "back" controls in the pass view** ("← ALL PASSES" in the sheet and the ← icon in the action bar) do the same thing, which reads as two different things. Keep one: the labelled one, with a ≥ 44 px row.
7. **Touch targets under 44 px:**
   - filter tabs All / Detailed / Weather: 32–36 px tall (All is 46×36);
   - sheet handle: 28 px tall (it's the drag affordance, so give it a 44 px hit area while keeping the 2-line look);
   - lightbox Replay: 95×32;
   - "Use my location" chip at 375: 106×40;
   - "Built by @armaangupt0": 15 px tall.
8. **Lightbox on a tall phone:** about 230 px of dead ink above the photo and 300 below. The caption wraps with orphan separators at line starts ("· 16:30 CET · 18 H AGO", "· 48.8535°N"). Anchor the photo higher (or top-align under the counter), break the caption at the separators, and say "swipe down to close" once.
9. **The HUD's top row collides at 375:** "HOW THIS WORKS" runs into "SUN 16.9°S 030.7°E" / "SCENE 12:06:47". At ≤ 380 the right readout needs to drop its first word or move to one line under the clock.
10. **The share card shows a verdict line** ("Clouded over. It saw only cloud.") and a "CLOUDED OVER · 100%" chip. The owner rule says "no verdict row". Confirm with the owner, then drop it. No coordinates appear on the card ✓.

### P2: polish

11. Results: the headline wraps "watched *Paris*." onto one tight line at 440. Fine, but at 375 check that the serif place name never breaks mid-name.
12. Suggestions show "6 MATCHES" but only 5 rows; the 6th is under a fade with no scroll hint.
13. Keyboard on Android (layout resizes): the landing flips to the short-landscape layout as soon as the keyboard opens, because `orientation: landscape` matches once height < width, and the typed text re-rendered as "Par". Base the short-landscape layout on `screen.orientation` or `visualViewport`, not the shrunken layout viewport.
14. The globe on phones: framing in the band above the sheet is good at all portrait sizes. At 375 the globe is small (about 210 px). The satellite dot size reads fine. No artifacts in Chromium; the iPhone artifact is PR #2.

## Status after Phase B (re-measured on integration @ c3e7a73, exact viewports)

| # | item | status |
|---|---|---|
| 1 | Back leaves the site | **fixed**: back stack (src/lib/backStack.ts); a deep or share link's Back lands on the landing |
| 2 | 375×667 pass view | **fixed**: "Share" ≤ 400 px; the flight snap clears the scrubber (232 px band kept) |
| 3 | landscape | round 3b fixed the layouts at the real 844×390 (Playwright's 750 px preset was under the stacked breakpoint); the acquisition countdown still ran off the left edge: **fixed** (wraps in the free band) |
| 4 | no way out of empty search mode | **fixed**: Cancel, plus the back gesture |
| 5 | chips run off the right edge | kept: round 3b made it a deliberate swipe row with a 28 px fade; wrapping costs ~48 px of globe at 375. Owner's call |
| 6 | two back controls in the pass view | kept: the labelled one (top) and the thumb-reach one (footer); Back works too |
| 7 | targets < 44 px | resolved by 3b: hit-tested, every target is ≥ 44 px (the grip, filter tabs and credit extend their hit areas) |
| 8 | lightbox caption separators | resolved by 3b |
| 9 | HUD collision at 375 | **fixed**: half tracking ≤ 380 px |
| 10 | share card cloud note | kept (not the removed verdict row) |
| 12–13 | "6 matches" / Android keyboard flip | not reproducible on real browsers (Chrome Android resizes the visual viewport only) |
