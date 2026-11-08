/**
 * Atmosphere rim, drawn on the BACK faces of a thin shell (≈1.025 R) with additive blending. For each pixel we
 * take the view ray's impact parameter b (closest approach to Earth's centre) and integrate an exponential
 * atmosphere along that chord, which is what a limb really looks like: brightest right at the surface, falling
 * off within a few pixels. Lighting uses the tangent point's sun angle (so the rim is brightest on the day
 * limb and fades fully on the night limb), a Rayleigh phase term, and a narrow forward-scatter lobe that
 * brightens the limb when looking toward the sun. Restraint: no thick glow.
 */
import { COMMON, glsl, OUTPUT } from './chunks'

export const atmosphereVertex = glsl`
  varying vec3 vPos;
  void main() {
    vPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
  }
`

export const atmosphereFragment = glsl`
  ${COMMON}
  uniform vec3 uSunDir;
  uniform float uShell;        // outer radius of the shell
  uniform float uScaleHeight;  // visual scale height, Earth radii
  uniform vec3 uRayleigh;      // pale blue-white
  uniform vec3 uHorizon;       // whiter near the surface
  uniform vec3 uTwilightColor;
  uniform float uIntensity;
  uniform float uReveal;
  varying vec3 vPos;

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vPos - ro);
    float tca = -dot(ro, rd);
    vec3 pc = ro + rd * tca;            // tangent point (closest approach to the centre)
    float b = length(pc);
    if (b < 1.0) discard;               // behind the planet (depth test also catches it)
    float h = b - 1.0;
    vec3 n = pc / b;
    vec3 L = normalize(uSunDir);

    // Chord optical depth of an exponential atmosphere ∝ exp(−h/H)·sqrt(b·H); fade to zero at the shell.
    float od = exp(-h / uScaleHeight);
    od *= 1.0 - smoothstep(0.55, 1.0, h / (uShell - 1.0));

    float mu = dot(n, L);
    // Lit side of the limb; light reaches a little past the terminator at altitude.
    float lit = smoothstep(-0.22, 0.28, mu);
    float cosT = dot(rd, L);
    float rayleigh = 0.75 * (1.0 + cosT * cosT);
    float forward = pow(max(cosT, 0.0), 10.0) * smoothstep(-0.25, 0.1, mu);
    float twilight = exp(-pow((mu - 0.02) / 0.14, 2.0));

    vec3 tint = mix(uHorizon, uRayleigh, smoothstep(0.0, 2.5 * uScaleHeight, h));
    vec3 col = tint * rayleigh * lit + uHorizon * forward * 1.6;
    col = mix(col, uTwilightColor * 0.9, twilight * 0.35 * lit);
    col *= od * uIntensity * uReveal;
    gl_FragColor = vec4(col, 1.0);
    ${OUTPUT}
  }
`
