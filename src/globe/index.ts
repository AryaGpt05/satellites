/**
 * globe: the 3D scene. See docs/ARCHITECTURE.md ("globe → src/globe/index.ts") and docs/DESIGN.md §6.
 * Only <GlobeCanvas/> is public. It reads the store (including uiInsets, motionBusyUntil and aboutOpen) and writes
 * only `globeReady`, `hoveredNorad` (hovers it started), `simTime` (the globe owns the clock: ~10 Hz in
 * live/replay, plus one exact write on pause; per-frame time goes to src/state/sceneClock.ts) and `cameraFlight`
 * (on flight start / arrival / cut / interrupt).
 */
export { GlobeCanvas } from './GlobeCanvas'
