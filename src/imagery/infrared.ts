/**
 * The redraws two NASA GIBS layers need before they are shown (the Clean Infrared rainbow on one grey scale,
 * Himawari's linear visible band on a square-root curve): the app's side of api/_lib/infrared.ts, where the code lives
 * so the share card's renderer (bundled apart from the app) redraws a frame exactly as the app does.
 */
export { brightenVisible, frameRedrawFor, greyInfrared, isEnhancedInfraredUrl, isLinearVisibleUrl } from '../../api/_lib/infrared'
