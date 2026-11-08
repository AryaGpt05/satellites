/**
 * Geometry conventions shared by engine + globe. DO NOT change conventions without updating both.
 *
 * WORLD FRAME (three.js scene):
 *   - Earth is a unit sphere centred at origin, radius 1 world unit = EARTH_RADIUS_KM.
 *   - The Earth mesh is FIXED (Earth-fixed / ECEF frame). We never rotate the Earth mesh;
 *     instead the sun direction and inertial objects (stars) rotate with GMST.
 *   - +Y = north pole. lat 0 / lon 0 → +X. lon +90°E → -Z.  (matches three.js SphereGeometry UVs
 *     with an equirectangular texture whose left edge is lon -180°.)
 *
 *   ECEF (x, y, z) km  →  world (x, z, -y) / R
 */
// Split in two so the first bundle carries no three.js: geoCore.ts is scalar maths (shell, engine, workers);
// geo3.ts holds the Vector3 helpers (globe), declared side-effect free in vite.config.ts.
export * from './geoCore'
export { latLonToWorld, worldToLatLon, ecefToWorld, sunDirectionWorld } from './geo3'

