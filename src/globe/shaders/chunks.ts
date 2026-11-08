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
