/**
 * Point-sprite shaders: stars, the satellite catalog, and the category glyph marker.
 * Sizes are in CSS pixels × uPx (device pixel ratio), so marks keep their weight on every screen.
 */
import { COMMON, glsl, KEPLER_J2, OUTPUT } from './chunks'

// ───────────────────────────── stars ─────────────────────────────

export const starsVertex = glsl`
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aTint;
  uniform float uPx;
  uniform float uReveal;
  varying float vAlpha;
  varying vec3 vTint;
  varying float vSize;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vSize = aSize * uPx;
    // Never let a star drop under one device pixel: dim it instead.
    float s = max(vSize, 1.0);
    vAlpha = aAlpha * uReveal * min(1.0, vSize * vSize);
    vSize = s;
    vTint = aTint;
    gl_PointSize = s + 1.0;   // +1 px for the anti-aliased edge
  }
`

export const starsFragment = glsl`
  varying float vAlpha;
  varying vec3 vTint;
  varying float vSize;
  void main() {
    float r = length(gl_PointCoord - 0.5) * (vSize + 1.0);
    float a = vAlpha * (1.0 - smoothstep(vSize * 0.5 - 0.5, vSize * 0.5 + 0.5, r));
    if (a < 0.003) discard;
    gl_FragColor = vec4(vTint, a);
    ${OUTPUT}
  }
`

// ───────────────────────────── satellite catalog ─────────────────────────────

/**
 * Every catalog object, propagated on the GPU. Ambient objects are bone at 35–55% alpha and 1–1.5 px with a
 * gentle size/alpha attenuation (front of the globe reads stronger than the limb); featured imagers are
 * slightly larger; satellites that imaged the place (aMark = 1) are signal-coloured and bloom slightly.
 * The selected / hovered objects are hidden here because a glyph marker is drawn over them.
 */
export const satellitesVertex = glsl`
  ${COMMON}
  ${KEPLER_J2}
  attribute vec4 aEl0;
  attribute vec4 aEl1;
  attribute vec4 aEl2;
  attribute float aMark;
  uniform float uPx;
  uniform int uHideA;
  uniform int uHideB;
  uniform float uShowAmbient;
  uniform float uReveal;
  uniform float uCamDist;     // camera distance to Earth's centre
  uniform vec3 uBone;
  uniform vec3 uSignal;
  uniform vec3 uIce;
  varying vec4 vColor;
  varying float vSize;

  void main() {
    vec3 p = keplerJ2World(aEl0, aEl1, aEl2);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;

    float category = aEl2.z;
    float featured = step(0.5, mod(aEl2.w, 2.0));
    // 1 in front of the globe's centre plane, 0 behind it: depth cue without a fog. Zoomed out, the whole
    // catalog overlaps into a halo, so it settles toward the quiet end of the range (1 px, 35%).
    float zoom = smoothstep(6.5, 2.2, uCamDist);
    float front = smoothstep(0.9, -0.9, dist - uCamDist) * mix(0.35, 1.0, zoom);

    float size = mix(1.0, 1.5, front);
    float alpha = mix(0.35, 0.55, front);
    vec3 col = uBone;
    if (featured > 0.5) {
      size = mix(2.0, 2.6, front);
      alpha = mix(0.62, 0.85, front);
      if (abs(category - 3.0) < 0.5) col = uIce;   // radar
    } else if (uShowAmbient < 0.5) {
      alpha = 0.0;
    }
    if (aMark > 0.5) {
      col = uSignal * 1.35;
      size = 3.2;
      alpha = 1.0;
    }
    if (gl_VertexID == uHideA || gl_VertexID == uHideB) alpha = 0.0;
    // Objects passing right in front of the lens (GEO/MEO seen from inside their shell) fade out.
    alpha *= smoothstep(0.35, 1.4, dist) * uReveal;

    // Whole device pixels keep small points crisp and stable as they move; coverage goes into alpha.
    float dev = size * uPx;
    float ps = max(1.0, floor(dev + 0.25));
    alpha *= min(1.0, (dev * dev) / (ps * ps));
    vSize = ps;
    vColor = vec4(col, alpha);
    gl_PointSize = ps < 2.5 ? ps : ps + 1.0;
    if (alpha < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);  // clip away
  }
`

export const satellitesFragment = glsl`
  varying vec4 vColor;
  varying float vSize;
  void main() {
    // Tiny points are solid pixels; larger ones are discs with a 1 px anti-aliased edge.
    float edge = 1.0;
    if (vSize > 2.5) {
      float r = length(gl_PointCoord - 0.5) * (vSize + 1.0);
      edge = 1.0 - smoothstep(vSize * 0.5 - 0.5, vSize * 0.5 + 0.5, r);
    }
    float a = vColor.a * edge;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor.rgb, a);
    ${OUTPUT}
  }
`

// ───────────────────────────── glyph marker ─────────────────────────────

/**
 * One satellite drawn as its category glyph (DESIGN.md §2): ◆/◇ open optical, □ commercial, □· radar,
 * ○ weather LEO, ◎ weather GEO, ✛ crewed, · other. 1 px strokes, anti-aliased, with a faint ink halo so the
 * mark reads on bright cloud. uFill = 1 draws the open-optical diamond solid ("an image exists").
 */
export const glyphVertex = glsl`
  uniform float uPx;
  uniform float uSize;
  uniform float uOpacity;
  varying float vSize;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vSize = uSize * uPx;
    gl_PointSize = vSize + 4.0 * uPx;
    if (uOpacity < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`

export const glyphFragment = glsl`
  ${COMMON}
  uniform float uPx;
  uniform int uShape;      // CATEGORY_INDEX
  uniform float uFill;
  uniform vec3 uColor;
  uniform vec3 uInk;
  uniform float uOpacity;
  varying float vSize;

  // Distance (px) to a 1 px stroke at signed distance d; returns coverage.
  float stroke(float d, float w) { return 1.0 - smoothstep(w * 0.5 - 0.5, w * 0.5 + 0.5, abs(d)); }
  float fillCov(float d) { return 1.0 - smoothstep(-0.5, 0.5, d); }

  void main() {
    float total = vSize + 4.0 * uPx;
    vec2 p = (gl_PointCoord - 0.5) * total;   // px, y down
    float R = vSize * 0.5;
    float w = uPx;                            // 1 CSS px
    float sdf;                                // signed distance to the main outline (px)
    float extra = 0.0;                        // additional strokes (centre dots, ticks)

    if (uShape == 1) {                        // diamond
      sdf = (abs(p.x) + abs(p.y) - R) * 0.70710678;
    } else if (uShape == 2 || uShape == 3) {  // square (radar: + centre dot)
      vec2 q = abs(p) - vec2(R * 0.78);
      sdf = max(q.x, q.y);
      if (uShape == 3) extra = fillCov(length(p) - 1.25 * uPx);
    } else if (uShape == 4) {                 // circle
      sdf = length(p) - R * 0.86;
    } else if (uShape == 5) {                 // ring with a tick
      sdf = length(p) - R * 0.86;
      extra = stroke(p.x, w) * step(abs(p.y + R * 0.86), R * 0.4) * step(p.y, 0.0);
    } else if (uShape == 6) {                 // plus
      float h = stroke(p.y, w) * step(abs(p.x), R);
      float v = stroke(p.x, w) * step(abs(p.y), R);
      extra = max(h, v);
      sdf = 1e3;
    } else {                                  // dot
      sdf = length(p) - 1.6 * uPx;
      extra = fillCov(sdf);
      sdf = 1e3;
    }

    float line = sdf < 1e2 ? stroke(sdf, w) : 0.0;
    float body = (uFill > 0.5 && sdf < 1e2) ? fillCov(sdf) : 0.0;
    float mark = max(max(line, body), extra);
    // Ink halo: the mark dilated by ~1.5 px, drawn under it at low alpha for legibility.
    float halo = sdf < 1e2 ? (1.0 - smoothstep(0.0, 2.0 * uPx, sdf - w)) * (uFill > 0.5 ? 1.0 : step(-w * 2.5, sdf))
                           : smoothstep(0.0, 1.0, mark * 3.0);
    halo = max(halo, mark);
    vec3 col = mix(uInk, uColor, mark);
    float a = max(mark, halo * 0.45) * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
    ${OUTPUT}
  }
`
