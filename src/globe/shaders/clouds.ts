/**
 * Cloud shell at ~1.006 R. Lit by the real sun with a soft terminator, a hint of self-shading from the
 * coverage gradient (so decks read as volume, not a decal), warm at twilight and almost gone at night
 * (a faint dark veil that still dims the city lights beneath).
 */
import { CLOUD_COVER, COMMON, glsl, OUTPUT, TANGENT_FRAME } from './chunks'

export const cloudsVertex = glsl`
  varying vec3 vPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
  }
`

export const cloudsFragment = glsl`
  ${COMMON}
  ${TANGENT_FRAME}
  ${CLOUD_COVER}

  uniform sampler2D uClouds;
  uniform vec2 uTexel;
  uniform vec3 uSunDir;
  uniform float uCloudOffset;
  uniform float uSunIntensity;
  uniform vec3 uCloudColor;
  uniform vec3 uTwilightColor;
  uniform vec3 uNightColor;
  uniform float uOpacity;

  varying vec3 vPos;
  varying vec2 vUv;

  void main() {
    vec3 N = normalize(vPos);
    vec3 V = normalize(cameraPosition - vPos);
    vec3 L = normalize(uSunDir);
    float NdL = dot(N, L);
    vec3 E, Nn;
    tangentFrame(N, E, Nn);
    float cosLat = max(length(N.xz), 0.04);

    vec2 uv = vUv + vec2(uCloudOffset, 0.0);
    float c = texture2D(uClouds, uv).r;
    float cover = cloudCover(c);
    if (cover < 0.004) discard;

    // Self-shading: treat coverage as thickness, light its gradient (thick cores bulge toward the sun).
    // LITE (phones): skip the 4 gradient fetches; decks get a coverage-based shade instead.
  #ifdef LITE
    float shade = mix(0.86, 1.02, cover) * mix(0.78, 1.06, sat01(NdL * 0.5 + 0.5));
  #else
    vec2 du = vec2(uTexel.x * 2.0, 0.0);
    vec2 dv = vec2(0.0, uTexel.y * 2.0);
    float gx = texture2D(uClouds, uv + du).r - texture2D(uClouds, uv - du).r;
    float gy = texture2D(uClouds, uv + dv).r - texture2D(uClouds, uv - dv).r;
    vec3 Nc = normalize(N - 0.9 * (gx / cosLat * E + gy * Nn));
    float shade = mix(0.78, 1.06, sat01(dot(Nc, L) * 0.5 + 0.5));
  #endif

    float dayMix = smoothstep(-0.05, 0.12, NdL);
    float lambert = sat01((NdL + 0.08) / 1.08);
    vec3 lit = uCloudColor * uSunIntensity * mix(0.32, 1.0, lambert) * shade;
    // Sunset: clouds near the terminator catch warm, low light.
    float band = gauss((NdL - 0.02) / 0.06);
    lit = mix(lit, uTwilightColor * uSunIntensity * 0.5, band * 0.38);

    vec3 col = mix(uNightColor, lit, dayMix);
    // Thin decks stay translucent; on the night side clouds are a faint veil.
    float alpha = cover * mix(0.16, 0.94, dayMix) * uOpacity;
    // Toward the limb clouds sink into the haze rather than outlining the disc.
    float limb = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    alpha *= 1.0 - 0.55 * limb;

    gl_FragColor = vec4(col, alpha);
    ${OUTPUT}
  }
`
