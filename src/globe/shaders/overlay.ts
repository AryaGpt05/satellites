/**
 * Surface overlays: the swath ribbon (with the pass's ground track as its centre line) and the place reticle,
 * plus screen-space hairlines (nadir line, view line, orbit trail). Strokes are measured in screen pixels with
 * fwidth(), so they stay 1 CSS px wide at any zoom and any obliquity.
 */
import { COMMON, glsl, OUTPUT } from './chunks'

// ───────────────────────────── swath ribbon ─────────────────────────────

export const ribbonVertex = glsl`
  attribute float aAlong;   // s relative to the pass's tClosest
  attribute float aSide;    // −1 left edge … 0 ground track … +1 right edge
  attribute float aU;       // 0 … 1 along the ribbon
  varying float vAlong;
  varying float vSide;
  varying float vU;
  varying vec3 vPos;        // world (the ribbon mesh has an identity transform; it lies on the surface)
  void main() {
    vAlong = aAlong;
    vSide = aSide;
    vU = aU;
    vPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
  }
`

/**
 * Reveal model: everything the sensor has swept (along ≤ uNow) is filled; the leading edge is a bright
 * 1.5 px line across the full swath with a short trailing glow (DESIGN.md §5's pushbroom language, on the
 * globe). Ahead of the edge only the swath edges remain, faint, as the predicted path; the ground track
 * appears (dashed, quiet) behind the edge.
 * uKind: 0 = fixed swath (solid edges), 1 = field of regard (dashed edges, faint fill), 2 = track only.
 */
export const ribbonFragment = glsl`
  ${COMMON}
  uniform float uNow;
  uniform float uPx;
  uniform int uKind;
  uniform vec3 uColor;
  uniform float uFill;
  uniform float uOpacity;
  uniform vec3 uSunDir;
  varying float vAlong;
  varying float vSide;
  varying float vU;
  varying vec3 vPos;

  float line(float d, float fw, float widthPx) {
    // d in the same units as fw (per-pixel derivative); widthPx in device px
    float px = abs(d) / max(fw, 1e-6);
    return 1.0 - smoothstep(widthPx * 0.5 - 0.5, widthPx * 0.5 + 0.5, px);
  }

  void main() {
    float fwA = fwidth(vAlong);
    float fwS = fwidth(vSide);
    float lead = uNow - vAlong;                  // > 0: swept
    float swept = smoothstep(-fwA, fwA, lead);
    float ends = smoothstep(0.0, 0.07, vU) * smoothstep(1.0, 0.93, vU);

    float w = uPx;                                // 1 CSS px
    float edgeD = 1.0 - abs(vSide);
    float edge = line(edgeD, fwS, w) * step(0.5, abs(vSide));
    float track = line(vSide, fwS, w);

    // Dashes for the field of regard: ~6 px on, 5 px off along-track, in screen space.
    float dashPx = vAlong / max(fwA, 1e-6) / max(uPx, 1.0);
    float dash = step(0.45, fract(dashPx / 11.0));

    float a = 0.0;
    vec3 col = uColor;
    float leadPx = lead / max(fwA, 1e-6) / max(uPx, 1.0);   // CSS px behind the leading edge (< 0: ahead)
    if (uKind == 2) {
      a = track * mix(0.3, 0.85, swept);
    } else {
      float edgeA = uKind == 1 ? edge * dash * mix(0.3, 0.62, swept) : edge * mix(0.34, 0.9, swept);
      // The ground track is quieter than the swath edges: the ribbon already implies it.
      float trackA = track * mix(0.0, 0.42, swept) * (uKind == 1 ? 1.0 : dash);
      // Fill: densest just behind the leading edge (the freshest lines, ~1 min of track), settling to a
      // lighter persistent tint so the swept corridor stays legible without becoming a slab.
      // uFill is tuned for the day side. Blending happens in linear light, where a fixed alpha reads far
      // stronger over dark ground (night side: ~2× the design's --signal-2), so the tint gives back alpha
      // where the surface under it is unlit.
      float daylight = smoothstep(-0.08, 0.2, dot(normalize(vPos), normalize(uSunDir)));
      float fillA = uFill * swept * (0.6 + 0.4 * exp(-max(lead, 0.0) / 60.0)) * mix(0.5, 1.0, daylight);
      // Leading edge: a 1.5 px line across the swath, with a short glow trailing it (~8 px).
      float leading = line(lead, fwA, 1.5 * w);
      float glow = swept * exp(-max(leadPx, 0.0) / 8.0) * 0.32;
      a = max(max(edgeA, trackA), fillA + glow);
      a = max(a, leading);
      // The edge and its glow sit just above 1.0, so the bloom gives them a faint halo.
      col *= 1.0 + 0.8 * max(leading, glow * 2.0);
    }
    a *= ends * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
    ${OUTPUT}
  }
`

// ───────────────────────────── place reticle ─────────────────────────────

/**
 * A flat quad in the tangent plane at the place, scaled every frame to a constant on-screen size. The
 * fragment shader draws in "reticle pixels" (quad uv × uSizePx): a 1 px ring, four ticks, a centre dot, an
 * ink halo under everything, and the lock-in / flash animations.
 */
export const reticleVertex = glsl`
  varying vec2 vP;
  uniform float uSizePx;
  void main() {
    vP = (uv - 0.5) * uSizePx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const reticleFragment = glsl`
  ${COMMON}
  uniform float uPx;
  uniform float uRing;       // ring radius, CSS px (animates 2× → 1× on lock-in)
  uniform float uRingBase;   // ring radius once locked, CSS px
  uniform float uLock;       // 0 → 1 as the reticle locks in
  uniform float uFlash;      // 1 → 0 after the swath crosses the place
  uniform float uPulse;      // 0 → 1 expanding ring of the flash
  uniform vec3 uColor;
  uniform vec3 uInk;
  uniform float uOpacity;
  varying vec2 vP;

  float strokePx(float d, float fw, float w) {
    float px = abs(d) / max(fw, 1e-6);
    return 1.0 - smoothstep(w * 0.5 - 0.5, w * 0.5 + 0.5, px);
  }

  void main() {
    vec2 p = vP;
    float r = length(p);
    float fw = fwidth(r);          // reticle px per device px
    float w = uPx;
    float R = uRing;

    float ring = strokePx(r - R, fw, w);
    // Ticks: 4 short radial strokes outside the ring (N/E/S/W), fixed length so the lock-in reads as the ring
    // closing onto the crosshair.
    float tIn = uRingBase + 4.0;
    float tOut = tIn + 9.0;
    vec2 ap = abs(p);
    float fwx = fwidth(p.x);
    float fwy = fwidth(p.y);
    float tickH = strokePx(p.y, fwy, w) * step(tIn, ap.x) * step(ap.x, tOut);
    float tickV = strokePx(p.x, fwx, w) * step(tIn, ap.y) * step(ap.y, tOut);
    float ticks = max(tickH, tickV) * uLock;
    float dotR = 2.0;
    float dotC = 1.0 - smoothstep(dotR - 0.5 * fw, dotR + 0.5 * fw, r);

    float mark = max(max(ring, ticks), dotC);
    // Ink halo for legibility over bright cloud.
    float halo = max(strokePx(r - R, fw, w * 4.5), max(dotC, 1.0 - smoothstep(dotR + 1.5, dotR + 3.5, r)));
    halo = max(halo, max(tickH, tickV) * uLock);

    // Flash: the ring flares and a pulse expands from it.
    float pulseR = R * (1.0 + 2.2 * uPulse);
    float pulse = strokePx(r - pulseR, fw, w * 1.5) * (1.0 - uPulse) * step(0.001, uPulse);

    // The halo matters most when the reticle sits inside a signal swath: ink keeps the ring legible.
    float a = max(mark, halo * 0.55) * uOpacity;
    vec3 col = mix(uInk, uColor * (1.0 + 0.8 * uFlash), mark);
    a = max(a, pulse * uOpacity);
    col = mix(col, uColor * 1.6, pulse);
    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
    ${OUTPUT}
  }
`

// ───────────────────────────── hairlines ─────────────────────────────

/**
 * Screen-space lines as instanced quads (one instance per segment). Width is in CSS px × uPx. Each segment
 * carries an alpha at both ends, so trails can fade. Endpoints behind the near plane are clipped to it.
 */
export const hairlineVertex = glsl`
  attribute vec3 aStart;
  attribute vec3 aEnd;
  attribute vec2 aAlpha;     // alpha at start, end
  uniform vec2 uResolution;  // drawing buffer, device px
  uniform float uWidth;      // CSS px
  uniform float uPx;
  varying float vAlpha;
  varying float vSide;
  varying float vHalf;

  void main() {
    vec4 s = modelViewMatrix * vec4(aStart, 1.0);
    vec4 e = modelViewMatrix * vec4(aEnd, 1.0);
    // Clip the segment against the near plane (view space z < 0 is in front of the camera).
    float nearZ = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
    if (s.z > -nearZ && e.z > -nearZ) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    if (s.z > -nearZ) s = mix(s, e, (s.z + nearZ) / (s.z - e.z));
    if (e.z > -nearZ) e = mix(e, s, (e.z + nearZ) / (e.z - s.z));
    vec4 cs = projectionMatrix * s;
    vec4 ce = projectionMatrix * e;
    vec2 ss = cs.xy / cs.w * uResolution * 0.5;
    vec2 se = ce.xy / ce.w * uResolution * 0.5;
    vec2 dir = se - ss;
    float len = length(dir);
    dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float hw = uWidth * uPx * 0.5 + 1.0;            // +1 px for anti-aliasing
    vec4 c = position.x < 0.5 ? cs : ce;
    // Extend half a pixel along the segment so joints overlap instead of gapping.
    vec2 along = dir * (position.x < 0.5 ? -0.5 : 0.5);
    c.xy += (nrm * position.y * hw + along) / (uResolution * 0.5) * c.w;
    gl_Position = c;
    vAlpha = position.x < 0.5 ? aAlpha.x : aAlpha.y;
    vSide = position.y * hw;
    vHalf = uWidth * uPx * 0.5;
  }
`

export const hairlineFragment = glsl`
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;
  varying float vSide;
  varying float vHalf;
  void main() {
    float cov = 1.0 - smoothstep(vHalf - 0.5, vHalf + 0.5, abs(vSide));
    float a = cov * vAlpha * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
    ${OUTPUT}
  }
`
