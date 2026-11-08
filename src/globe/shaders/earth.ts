/**
 * Earth surface. Photoreal but graded (DESIGN.md §6):
 *  - day/night blend on N·L (geometric normal) with a soft terminator and a faint warm twilight band
 *  - day colour desaturated 12%, cool-neutral; oceans pulled toward deep ink
 *  - relief: bump-mapped from the data texture's R channel (central differences, in radians on the sphere)
 *  - ocean specular glint (Blinn-Phong core + broad sheen, Schlick Fresnel) from the real sun
 *  - cloud shadows: the cloud texture sampled toward the sun by the shell height / N·L
 *  - city lights tinted sodium amber, only on the dark side, dimmed under cloud
 *  - day-side haze toward the limb, matching the atmosphere rim colour
 * Output is linear HDR. Only city-light cores exceed 1.0 (so only they reach the bloom threshold).
 */
import { CLOUD_COVER, COMMON, glsl, OUTPUT, TANGENT_FRAME } from './chunks'

export const earthVertex = glsl`
  varying vec3 vPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
  }
`

export const earthFragment = glsl`
  ${COMMON}
  ${TANGENT_FRAME}
  ${CLOUD_COVER}

  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform sampler2D uClouds;
  uniform sampler2D uData;
  uniform vec2 uDataTexel;      // 1 / data texture size
  uniform vec3 uSunDir;
  uniform float uCloudOffset;
  uniform float uSunIntensity;
  uniform float uBump;          // relief exaggeration, Earth radii per unit of the R channel
  uniform float uCloudHeight;   // cloud shell height above the surface, Earth radii
  uniform vec3 uCityColor;
  uniform vec3 uTwilightColor;
  uniform vec3 uHazeColor;
  uniform vec3 uNightTint;
  uniform float uReveal;

  varying vec3 vPos;
  varying vec2 vUv;

  vec3 gradeDay(vec3 c, float ocean) {
    float l = luma(c);
    // −12% saturation, cool-neutral balance.
    c = mix(vec3(l), c, 0.88) * vec3(0.96, 0.99, 1.03);
    // Oceans: deep and quiet, toward ink-navy, so land, cloud and the glint carry the image.
    vec3 sea = mix(vec3(l), c, 0.55) * vec3(0.46, 0.56, 0.7);
    return mix(c, sea, ocean);
  }

  void main() {
    vec3 N = normalize(vPos);
    vec3 V = normalize(cameraPosition - vPos);
    vec3 L = normalize(uSunDir);
    float NdL = dot(N, L);
    vec3 E, Nn;
    tangentFrame(N, E, Nn);
    float cosLat = max(length(N.xz), 0.04);

    // ── data: elevation (R) + ocean mask (G)
    vec4 data = texture2D(uData, vUv);
    float ocean = smoothstep(0.35, 0.65, data.g);
    float land = 1.0 - ocean;

    // ── relief: central differences over 1.5 texels, converted to slope per radian on the sphere.
    // LITE (phones): no relief fetches; at phone sizes the 1k elevation map reads as noise anyway.
  #ifdef LITE
    vec3 Nb = N;
  #else
    vec2 du = vec2(uDataTexel.x * 1.5, 0.0);
    vec2 dv = vec2(0.0, uDataTexel.y * 1.5);
    float hE = texture2D(uData, vUv + du).r;
    float hW = texture2D(uData, vUv - du).r;
    float hN = texture2D(uData, vUv + dv).r;
    float hS = texture2D(uData, vUv - dv).r;
    vec2 slope = vec2((hE - hW) / (2.0 * du.x * TWO_PI * cosLat), (hN - hS) / (2.0 * dv.y * PI));
    // The elevation source is soft at coastlines: keep relief off the sea and fade it out at the poles' pinch.
    float reliefMask = land * smoothstep(0.02, 0.12, cosLat);
    vec3 Nb = normalize(N - uBump * reliefMask * (slope.x * E + slope.y * Nn));
  #endif

    // ── clouds (for shadows and to dim lights / glint)
    vec2 cloudUv = vUv + vec2(uCloudOffset, 0.0);
    float cloudHere = cloudCover(texture2D(uClouds, cloudUv).r);
  #ifdef LITE
    // One fetch: the shadow sits under its cloud (the sun-ward offset is a few pixels at phone scale).
    float cloudShadow = cloudHere;
  #else
    // The cloud above a surface point P that shades it sits toward the sun, displaced by h / N·L.
    vec2 sunT = vec2(dot(L, E), dot(L, Nn));
    vec2 shift = sunT * (uCloudHeight / max(NdL, 0.12)) * vec2(1.0 / (TWO_PI * cosLat), 1.0 / PI);
    float cloudShadow = cloudCover(texture2D(uClouds, cloudUv + shift).r);
  #endif

    // ── day
    vec3 dayTex = texture2D(uDay, vUv).rgb;
    // A touch of contrast in linear light: deeper mid-tones, highlights kept.
    vec3 albedo = pow(gradeDay(dayTex, ocean), vec3(1.12)) * 1.06;
    // Soft terminator: the sun is a disc and the atmosphere scatters past the geometric line.
    float dayMix = smoothstep(-0.05, 0.09, NdL);
    float lambert = sat01((NdL + 0.04) / 1.04);
    // Relief as a bounded hill-shade on top of the geometric light: slopes brighten / darken, never go black.
    float relief = clamp(1.0 + (dot(Nb, L) - NdL) * 2.2, 0.62, 1.32);
    vec3 day = albedo * uSunIntensity * lambert * mix(1.0, relief, smoothstep(0.0, 0.08, NdL));
    // Low sun: light that grazed the atmosphere arrives reddened.
    float lowSun = exp(-pow((NdL - 0.03) / 0.11, 2.0));
    day *= mix(vec3(1.0), vec3(1.0, 0.74, 0.55), lowSun * 0.5);
    day *= 1.0 - 0.38 * cloudShadow * smoothstep(0.0, 0.2, NdL);

    // Ocean glint: a tight core plus a broad sheen, Fresnel-weighted, killed by cloud and low sun.
    vec3 H = normalize(L + V);
    float NdH = max(dot(N, H), 0.0);
    float VdH = max(dot(V, H), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - VdH, 5.0);
    float spec = pow(NdH, 220.0) * 0.55 + pow(NdH, 28.0) * 0.045;
    spec *= (0.35 + fres) * ocean * (1.0 - 0.9 * cloudHere) * smoothstep(0.0, 0.25, NdL);
    day += vec3(1.0, 0.97, 0.92) * spec * uSunIntensity;

    // Day-side haze toward the limb (Rayleigh-ish, pale blue-white), continuous with the atmosphere rim.
    float NdV = max(dot(N, V), 0.0);
    float limb = pow(1.0 - NdV, 3.2);
    float hazeLight = smoothstep(0.02, 0.45, NdL);
    day = mix(day, uHazeColor * uSunIntensity * 0.4 * hazeLight, limb * 0.7 * smoothstep(-0.02, 0.2, NdL));

    // ── night
    vec3 nightTex = texture2D(uNight, vUv).rgb;
    float nl = luma(nightTex);
    // Night ground: never a void (PRD-09). A cool-neutral floor clearly above space (#07080A): night ocean
    // ≈ #0E1114 (linear 0.0046, 0.0057, 0.0070), land a shade lighter, plus faint earthshine from the day albedo
    // so coastlines and ice read. City lights sit far above this, so their contrast is kept.
    float earthshine = luma(dayTex) * 0.012;
    vec3 nightBase = vec3(0.0046, 0.0057, 0.0070) * mix(1.3, 1.0, ocean) + uNightTint * earthshine + vec3(nl) * uNightTint * 0.25;
    // Lights: isolate from the map's base, sodium amber with warmer-white cores; only the brightest cores
    // exceed 1.0, so the bloom stays a whisper.
    float lights = smoothstep(0.014, 0.55, nl);
    lights = pow(lights, 1.45);
    float lightsOn = 1.0 - smoothstep(-0.14, 0.03, NdL);
    vec3 cityTint = mix(uCityColor, vec3(1.0, 0.8, 0.58), lights * lights * lights * 0.8);
    vec3 city = cityTint * lights * (1.0 - 0.45 * cloudHere) * 1.7;
    vec3 night = nightBase + city * lightsOn;

    vec3 col = mix(night, day, dayMix);

    // ── twilight: the faintest warm glow just past the terminator (the dark side is nearly ink, so this is tiny)
    float dusk = exp(-pow((NdL + 0.035) / 0.05, 2.0));
    col += uTwilightColor * dusk * 0.003;

    gl_FragColor = vec4(col * uReveal, 1.0);
    ${OUTPUT}
  }
`

/** Shown only if the texture set fails to load: an ink sphere with a hairline graticule and the real terminator. */
export const earthFallbackFragment = glsl`
  ${COMMON}
  uniform vec3 uSunDir;
  uniform vec3 uLine;
  uniform vec3 uInk;
  varying vec3 vPos;
  varying vec2 vUv;
  float gridLine(float x, float steps) {
    float f = abs(fract(x * steps + 0.5) - 0.5) / fwidth(x * steps);
    return 1.0 - sat01(f);
  }
  void main() {
    vec3 N = normalize(vPos);
    float day = smoothstep(-0.05, 0.2, dot(N, normalize(uSunDir)));
    float g = max(gridLine(vUv.x, 24.0), gridLine(vUv.y, 12.0));
    vec3 col = uInk * (0.8 + 0.6 * day) + uLine * g * (0.05 + 0.08 * day);
    gl_FragColor = vec4(col, 1.0);
    ${OUTPUT}
  }
`
