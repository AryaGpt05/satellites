/**
 * Post (DESIGN.md §6): very mild bloom that only the signal marks and city-light cores reach (they are the
 * only things written above 1.0), a hue-preserving shoulder tone curve that leaves the ink / bone palette
 * exact (toneShoulder.ts), film grain within ±3%, a gentle vignette. No chromatic aberration, no lens flare.
 *
 * The composer is built directly on `postprocessing` (not the React wrapper, whose index also pulls in an SSAO
 * library we never use), so the scene owns it: the shader warm-up renders through it (Scene.tsx), and its size
 * only changes when the drawing buffer does.
 *
 * GPU budget (PERF-08): MSAA only where it pays (desktop at DPR < 1.5; points and hairlines anti-alias in their
 * shaders anyway); phones run a lighter bloom (3 mip levels from a half-resolution luminance pass).
 */
import { useFrame, useThree } from '@react-three/fiber'
import { BlendFunction, BloomEffect, EffectComposer, EffectPass, NoiseEffect, RenderPass, ShaderPass, VignetteEffect } from 'postprocessing'
import { ShaderMaterial } from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { UI_ENTRANCE_EVENT } from '@/lib/uiEvents'
import { HalfFloatType, Vector2 } from 'three'
import { msaaFor } from './quality'
import { useRuntime } from './runtime'
import { ToneShoulderEffect } from './toneShoulder'

/** Bloom whose luminance + mip chain run at a fraction of the drawing buffer (the mipmap path ignores resolutionScale). */
class ScaledBloomEffect extends BloomEffect {
  constructor(
    private scale: number,
    options: ConstructorParameters<typeof BloomEffect>[0],
  ) {
    super(options)
  }
  setSize(width: number, height: number) {
    super.setSize(Math.max(1, Math.round(width * this.scale)), Math.max(1, Math.round(height * this.scale)))
  }
}

/** Render priority of the composer (any positive priority takes over R3F's own render). */
export const POST_PRIORITY = 1

/**
 * Sanitise the scene colour before bloom: any NaN/Inf (or runaway HDR value) becomes a finite colour.
 * Bloom's mip chain turns a single non-finite pixel into a flickering black square, and GPUs differ in what
 * they return for undefined maths (Apple GPUs give NaN where others don't), so this is a hard backstop.
 * Comparisons with NaN are false, so `!(x >= 0 && x <= MAX)` catches NaN, ±Inf and negatives.
 */
function sanitizePass(): ShaderPass {
  const material = new ShaderMaterial({
    name: 'SanitizeMaterial',
    uniforms: { inputBuffer: { value: null } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 1.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D inputBuffer;
      varying vec2 vUv;
      float fin(float x) { return (x >= 0.0 && x <= 64.0) ? x : (x > 64.0 && x < 1e30 ? 64.0 : 0.0); }
      void main() {
        vec4 c = texture2D(inputBuffer, vUv);
        gl_FragColor = vec4(fin(c.r), fin(c.g), fin(c.b), (c.a >= 0.0 && c.a <= 1.0) ? c.a : 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  })
  return new ShaderPass(material, 'inputBuffer')
}

/** Build the composer for this canvas and render it every frame. Returns it (for the shader warm-up). */
export function usePost(): EffectComposer {
  const rt = useRuntime()
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const dpr = useThree((s) => s.viewport.dpr)
  const { mobile } = rt.tier
  const msaa = msaaFor(rt.tier, dpr)

  const composer = useMemo(() => {
    const c = new EffectComposer(gl, { multisampling: msaa, frameBufferType: HalfFloatType, stencilBuffer: false })
    c.addPass(new RenderPass(scene, camera))
    c.addPass(sanitizePass())
    const bloom = new ScaledBloomEffect(mobile ? 0.5 : 1, {
      mipmapBlur: true,
      luminanceThreshold: 1.0,
      luminanceSmoothing: 0.15,
      intensity: 0.45,
      radius: 0.62,
      levels: mobile ? 3 : 6,
    })
    // premultiply: output = colour × noise; NORMAL at 5.5% → luminance-proportional grain within ±3%.
    const noise = new NoiseEffect({ premultiply: true, blendFunction: BlendFunction.NORMAL })
    noise.blendMode.opacity.value = 0.055
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.42, eskil: false })
    c.addPass(new EffectPass(camera, bloom, new ToneShoulderEffect(), noise, vignette))
    return c
  }, [gl, scene, camera, msaa, mobile])
  useEffect(() => () => composer.dispose(), [composer])
  // Phones: the frame after a heavy UI entrance keeps the last image (src/lib/uiEvents.ts), so the panel's layout
  // and this frame's draw are two tasks, not one long one.
  useEffect(() => {
    if (!mobile) return
    const onEntrance = () => void (rt.skipRender = Math.max(rt.skipRender, 1))
    window.addEventListener(UI_ENTRANCE_EVENT, onEntrance)
    return () => window.removeEventListener(UI_ENTRANCE_EVENT, onEntrance)
  }, [rt, mobile])

  const size = useMemo(() => new Vector2(), [])
  const applied = useRef({ composer: null as EffectComposer | null, w: -1, h: -1, dpr: -1 })
  useFrame((_, delta) => {
    // A frame held for AdaptiveDpr's drain (the canvas keeps showing the last image).
    if (rt.skipRender > 0) {
      rt.skipRender--
      return
    }
    gl.getSize(size)
    const pr = gl.getPixelRatio()
    const a = applied.current
    if (a.composer !== composer || size.x !== a.w || size.y !== a.h || pr !== a.dpr) {
      composer.setSize(size.x, size.y)
      a.composer = composer
      a.w = size.x
      a.h = size.y
      a.dpr = pr
    }
    // postprocessing switches the renderer's autoClear off; the scene pass needs it on, so three's background
    // step clears the (linear) input buffer with the clear colour converted for THAT target. Without it the
    // clear pass reuses the sRGB-converted colour from the last on-screen render and space turns grey.
    const autoClear = gl.autoClear
    gl.autoClear = true
    composer.render(delta)
    gl.autoClear = autoClear
  }, POST_PRIORITY)

  return composer
}
