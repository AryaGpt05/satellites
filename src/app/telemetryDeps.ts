/**
 * What the lazily loaded src/app/telemetry.ts needs from the app, handed over by src/main.tsx. All three are in
 * the entry chunk already, so this module adds nothing to the bundle but the namespace object.
 */
export { useApp } from '@/state/store'
export { getSatInfo } from '@/engine/catalog'
export { cityLevelLabel } from '@/lib/backend'
