/**
 * Shared GLSL. Every material in the globe is a ShaderMaterial that writes linear HDR colour and ends with
 * `OUTPUT` so it is correct both through the post-processing chain (render target: linear, tone mapped by
 * <ToneMapping/>) and when post is off (renderer tone maps + encodes sRGB itself).
 *
 * three.js compiles ShaderMaterial as GLSL ES 3.00 on WebGL 2 (attribute/varying/texture2D are #defined),
 * so `gl_VertexID` is available.
 */

/** Tag for syntax highlighting in editors; returns the string unchanged. */
export const glsl = (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v)

export const OUTPUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`

export const COMMON = glsl`
  #define PI 3.141592653589793
  #define TWO_PI 6.283185307179586
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float sat01(float x) { return clamp(x, 0.0, 1.0); }
  // exp(−x²) without pow(): GLSL leaves pow() undefined for a negative base and Apple GPUs (Metal) return NaN,
  // which the bloom mip chain spreads into flickering black squares. Never use pow(x, 2.0) on signed values.
  float gauss(float x) { return exp(-x * x); }
`

/**
 * Kepler + J2 secular propagation, ported verbatim from the MATH block in src/engine/elements.ts
 * (reference implementation: keplerJ2World). Element layout = ElementBuffer stride 12 as three vec4s:
 *   el0 = [a, e, i, raan0]   el1 = [argp0, M0, n, raanDot]   el2 = [argpDot, epochOffset, category, flags]
 * uTime = (simTime − refEpochMs) / 1000 and uGmst = (cos, sin)(gmst(simTime)) are computed on the CPU in
 * float64 every frame.
 */
export const KEPLER_J2 = glsl`
  uniform highp float uTime;
  uniform highp vec2 uGmst;

  highp vec3 keplerJ2World(highp vec4 el0, highp vec4 el1, highp vec4 el2) {
    highp float a = el0.x;
    highp float e = el0.y;
    highp float inc = el0.z;
    highp float dt = uTime - el2.y;
    // Wrap BEFORE any trig: n·dt reaches ~700 rad over a ±7 day scrub.
    highp float M = mod(el1.y + el1.z * dt, TWO_PI);
    highp float raan = el0.w + el1.w * dt;
    highp float argp = el1.x + el2.x * dt;
    // Kepler's equation E − e sin E = M, 4 Newton steps from E0 = M + e sin M.
    highp float E = M + e * sin(M);
    for (int k = 0; k < 4; k++) E -= (E - e * sin(E) - M) / max(1.0 - e * cos(E), 1e-3);
    // Perifocal position.
    highp float xp = a * (cos(E) - e);
    highp float yp = a * sqrt(max(1.0 - e * e, 0.0)) * sin(E);
    // Perifocal → inertial (TEME): R3(−Ω) · R1(−i) · R3(−ω).
    highp float cO = cos(raan);
    highp float sO = sin(raan);
    highp float cw = cos(argp);
    highp float sw = sin(argp);
    highp float ci = cos(inc);
    highp float si = sin(inc);
    highp float x = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
    highp float y = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
    highp float z = (sw * si) * xp + (cw * si) * yp;
    // Inertial → Earth-fixed (rotate by −GMST), as geo.ts eciToEcef.
    highp float xe = uGmst.x * x + uGmst.y * y;
    highp float ye = -uGmst.y * x + uGmst.x * y;
    // Earth-fixed → three.js world, as geo.ts ecefToWorld (units are already Earth radii).
    return vec3(xe, z, -ye);
  }
`

/**
 * Local east / north unit vectors on the unit sphere at n (world frame, see src/lib/geo.ts).
 * Matches cameraMath.eastNorth; at the exact pole east falls back to lon 0's east.
 */
export const TANGENT_FRAME = glsl`
  void tangentFrame(vec3 n, out vec3 east, out vec3 north) {
    vec3 e = vec3(n.z, 0.0, -n.x);
    float l = length(e);
    east = l < 1e-6 ? vec3(0.0, 0.0, -1.0) : e / l;
    north = cross(n, east);
  }
`

/** Cloud coverage from the cloud texture: the texture has a grey floor, so remap to sparse, crisp clouds. */
export const CLOUD_COVER = glsl`
  float cloudCover(float c) { return smoothstep(0.16, 0.78, c); }
`

/**
 * Regional imagery painted onto the planet (Imagery.tsx, acquisition.ts). Shared by the Earth and the cloud shell,
 * driven by uniforms only (no program variants):
 *  - the CONTEXT patch: a sharp regional basemap (NASA Blue Marble, ~0.7 km/px) around the place, feathered into the
 *    global map, so the close pass views stay crisp below the global map's texture floor;
 *  - the DECAL: the selected pass's real captured image, DEVELOPED exactly where the scan line has passed
 *    (uScanS vs. the along-track position asin(N · t0)), with a short bright fresh-exposure band behind the line;
 *    uFull forces the developed state (settled views, quiet selections, reduced motion). Black (no-data) is keyed out.
 * Patch bounds are (u centre, v centre, u width, v height) in the sphere's equirectangular uv (u = 0.5 + lon/360,
 * v = 0.5 + lat/180); textures are uploaded unflipped (row 0 = north). Sampling uses explicit gradients, so a patch
 * edge never picks a wrong mip level.
 */
export const PAINT = glsl`
  uniform sampler2D uCtxMap;
  uniform vec4 uCtxUv;
  uniform float uCtxOn;
  uniform float uCtxLod;          // mip level of the patch at the tone-matching scale (~60 km)
  uniform sampler2D uDecalMap;
  uniform vec4 uDecalUv;
  uniform float uDecalOn;
  uniform sampler2D uDecal2Map;   // the previous image, fully developed, under the current one while it fades in
  uniform vec4 uDecal2Uv;
  uniform float uDecal2On;
  uniform float uDecalLit;        // 1: an image that needs no sun (radar), shown on the night side too
  uniform float uDecal2Lit;
  uniform vec3 uScanT0;
  uniform float uScanS;
  uniform float uFull;
  uniform float uFreshRad;

  vec2 sphereUv(vec3 n) {
    return vec2(0.5 + atan(-n.z, n.x) / TWO_PI, 0.5 + asin(clamp(n.y, -1.0, 1.0)) / PI);
  }
  /** Patch coordinates (0..1 inside, y up = north) of a sphere uv, wrapping at the patch's antipode. */
  vec2 patchCoord(vec2 uv, vec4 b) {
    float dx = uv.x - b.x;
    dx -= floor(dx + 0.5);
    return vec2(0.5 + dx / b.z, 0.5 + (uv.y - b.y) / b.w);
  }
  /** 0 outside, 1 inside, with an edge ramp f (patch units). */
  float patchMask(vec2 p, vec2 f) {
    vec2 a = smoothstep(vec2(0.0), f, p) * smoothstep(vec2(0.0), f, 1.0 - p);
    return a.x * a.y;
  }
  /**
   * Context basemap colour (linear) and weight. low gets the patch's own colour at the tone-matching scale, so the
   * caller can keep the global map's low-frequency tone and take only the patch's detail (no visible square).
   */
  vec4 contextSample(vec2 uv, out vec3 low) {
    vec2 p = patchCoord(uv, uCtxUv);
    vec2 t = vec2(p.x, 1.0 - p.y);
    vec3 c = textureGrad(uCtxMap, t, dFdx(t), dFdy(t)).rgb;
    low = textureLod(uCtxMap, t, uCtxLod).rgb;
    float w = patchMask(p, vec2(0.16)) * uCtxOn;
    return vec4(c, w);
  }
  /**
   * Decal colour (linear) and developed weight (rgb, a); fresh gets the fresh-exposure amount (0..1) behind the
   * scan line.
   */
  vec4 decalSample(vec3 n, vec2 uv, out float fresh) {
    vec2 p = patchCoord(uv, uDecalUv);
    vec2 t = vec2(p.x, 1.0 - p.y);
    vec2 gx = dFdx(t);
    vec2 gy = dFdy(t);
    vec3 c = textureGrad(uDecalMap, t, gx, gy).rgb;
    // Anti-aliased hard edge (about a pixel), no-data (pure black) keyed out.
    vec2 fwp = max(abs(gx) + abs(gy), vec2(1e-6));
    float inside = patchMask(p, fwp * 1.5);
    float key = smoothstep(0.0025, 0.012, max(c.r, max(c.g, c.b)));
    // Development: behind the scan line, or forced.
    float s = asin(clamp(dot(n, uScanT0), -1.0, 1.0));
    float lead = uScanS - s;
    float fw = max(fwidth(s), 1e-7);
    float swept = smoothstep(-fw, fw, lead);
    float dev = max(uFull, swept);
    fresh = swept * (1.0 - uFull) * (1.0 - smoothstep(0.0, max(uFreshRad, 1e-6), lead));
    return vec4(c, inside * key * dev * uDecalOn);
  }
  /** The previous decal (fully developed), for crossfades between passes. */
  vec4 decalPrevSample(vec2 uv) {
    vec2 p = patchCoord(uv, uDecal2Uv);
    vec2 t = vec2(p.x, 1.0 - p.y);
    vec2 gx = dFdx(t);
    vec2 gy = dFdy(t);
    vec3 c = textureGrad(uDecal2Map, t, gx, gy).rgb;
    vec2 fwp = max(abs(gx) + abs(gy), vec2(1e-6));
    float key = smoothstep(0.0025, 0.012, max(c.r, max(c.g, c.b)));
    return vec4(c, patchMask(p, fwp * 1.5) * key * uDecal2On);
  }
`
