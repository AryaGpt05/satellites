/**
 * globe: the 3D scene. See docs/ARCHITECTURE.md ("globe → src/globe/index.ts") and docs/DESIGN.md §6.
 * Only <GlobeCanvas/> is public. It reads the store and writes only `globeReady`, `hoveredNorad` (hovers it
 * started) and `simTime` (the globe owns the clock: ~10 Hz in live/replay, plus one exact write on pause).
 */
export { GlobeCanvas } from './GlobeCanvas'
