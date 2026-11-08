/**
 * globe: the 3D scene. See docs/ARCHITECTURE.md ("globe → src/globe/index.ts") and docs/DESIGN.md §6.
 * Only <GlobeCanvas/> is public; it reads the store and writes only `globeReady` and `hoveredNorad`.
 */
export { GlobeCanvas } from './GlobeCanvas'
