/**
 * Hue-preserving shoulder tone curve for the post chain.
 *
 * Why not ACES / AgX / PBR-Neutral: all of them reshape the darks. PBR-Neutral, for instance, subtracts the
 * smallest channel near black, which turns --ink-0 (#07080A) into (0, 1, 3) and over-saturates the oceans.
 * The art direction is built on exact ink and bone values, so this curve is the identity below a knee (the
 * whole SDR palette passes through untouched) and only compresses the few HDR values above it: city-light
 * cores and the signal marks. Compression scales all three channels together (hue kept), with a slight
 * film-like desaturation for extreme highlights.
 */
import { BlendFunction, Effect } from 'postprocessing'

const fragment = /* glsl */ `
  const float KNEE = 0.82;
  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec3 c = max(inputColor.rgb, vec3(0.0));
    float m = max(max(c.r, c.g), c.b);
    if (m > KNEE) {
      float over = (m - KNEE) / (1.0 - KNEE);
      float mm = KNEE + (1.0 - KNEE) * (1.0 - exp(-over));
      vec3 r = c * (mm / m);
      float t = clamp((m - 1.0) / 4.0, 0.0, 1.0);
      c = mix(r, vec3(mm), t * 0.3);
    }
    outputColor = vec4(c, inputColor.a);
  }
`

export class ToneShoulderEffect extends Effect {
  constructor() {
    super('ToneShoulderEffect', fragment, { blendFunction: BlendFunction.SRC })
  }
}
