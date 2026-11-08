/**
 * The acquisition sequence's own marks (owner request C): the spacecraft model and the sensor's light curtain.
 * The ground scan line and the swath outline are the ribbon (overlay.ts); the developing image is painted by the
 * Earth shader (chunks.ts PAINT).
 */
import { COMMON, glsl, OUTPUT } from './chunks'

// ───────────────────────────── spacecraft ─────────────────────────────

/**
 * A small low-poly spacecraft (bus, one solar wing, the instrument looking down): bone body, ink array with a hairline
 * cell grid, one signal accent (the instrument's aperture). Lit by the real sun when it is not in Earth's shadow
 * (uLit), with a little earthshine from below and a rim so the silhouette always reads against the planet.
 */
export const spacecraftVertex = glsl`
  attribute float aPart;      // 0 bus, 1 solar array, 2 accent, 3 instrument / dark
  varying vec3 vN;
  varying vec3 vPos;
  varying vec2 vUv;
  varying float vPart;
  void main() {
    vN = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    vPart = aPart;
    vPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
  }
`

export const spacecraftFragment = glsl`
  ${COMMON}
  uniform vec3 uSunDir;
  uniform float uLit;
  uniform vec3 uBone;
  uniform vec3 uInk;
  uniform vec3 uSignal;
  uniform float uOpacity;
  varying vec3 vN;
  varying vec3 vPos;
  varying vec2 vUv;
  varying float vPart;

  void main() {
    vec3 N = normalize(vN);
    if (!gl_FrontFacing) N = -N;
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vPos);
    float ndl = max(dot(N, L), 0.0);
    vec3 base = uBone * 0.82;
    float spec = 0.0;
    if (vPart > 0.5 && vPart < 1.5) {
      // Solar array: deep blue cells on a bone frame grid (hairlines in screen space), with a sun glint.
      vec2 g = vUv * vec2(4.0, 9.0);
      vec2 d = abs(fract(g - 0.5) - 0.5) / max(fwidth(g), vec2(1e-5));
      float grid = 1.0 - min(min(d.x, d.y), 1.0);
      base = mix(vec3(0.035, 0.05, 0.1), uBone * 0.85, grid * 0.8);
      vec3 H = normalize(L + V);
      spec = pow(max(dot(N, H), 0.0), 36.0) * 0.8;
    } else if (vPart > 2.5) {
      base = uInk * 3.0 + vec3(0.01);
    }
    float earth = max(dot(N, -normalize(vPos)), 0.0) * 0.16;
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 col = base * (0.1 + uLit * (0.25 + ndl * 0.95) + earth) + uBone * rim * 0.18 + vec3(1.0, 0.96, 0.9) * spec * uLit;
    if (vPart > 1.5 && vPart < 2.5) col = uSignal * (0.9 + 0.5 * uLit);
    gl_FragColor = vec4(col, uOpacity);
    ${OUTPUT}
  }
`

// ───────────────────────────── light curtain ─────────────────────────────

/**
 * The pushbroom's field of view as a translucent fan from the spacecraft down to the swath's true cross-track width:
 * additive and very faint, denser toward the ground, with fine scan lines streaming down it (wall time), like the
 * instrument reading lines. Its bright edges are hairlines and its foot is the ribbon's scan line.
 */
export const curtainVertex = glsl`
  attribute float aV;   // 0 at the spacecraft → 1 on the ground
  attribute float aS;   // −1 … +1 across the swath
  varying float vV;
  varying float vS;
  void main() {
    vV = aV;
    vS = aS;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const curtainFragment = glsl`
  ${COMMON}
  uniform vec3 uColor;
  uniform vec3 uBone;
  uniform float uOpacity;
  uniform float uTime;   // wall seconds
  varying float vV;
  varying float vS;
  void main() {
    // A whisper of light, warmest and densest toward the ground; the colour is mostly bone, tinted by the verdict.
    vec3 tint = mix(uBone, uColor, 0.45);
    // (Additive in linear light: over dark ground even 0.01 reads clearly, so everything here is tiny.)
    float body = mix(0.0006, 0.006, vV * vV);
    // Scan lines streaming down: ~1 px lines, 40 across the curtain's height.
    float k = vV * 40.0 - uTime * 2.6;
    float f = fract(k);
    float dpx = min(f, 1.0 - f) / max(fwidth(k), 1e-5);
    float lines = (1.0 - smoothstep(0.3, 1.2, dpx)) * (0.15 + 0.85 * vV * vV);
    // A soft brightening toward the two edges.
    float edge = smoothstep(0.86, 1.0, abs(vS)) * 0.008;
    float a = (body + lines * 0.009 + edge) * uOpacity;
    if (a < 0.0002) discard;
    gl_FragColor = vec4(tint, a);
    ${OUTPUT}
  }
`
