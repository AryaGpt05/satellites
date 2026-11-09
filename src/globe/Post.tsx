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
import { BlendFunction, BloomEffect, EffectComposer, EffectPass, NoiseEffect, Pass, RenderPass, ShaderPass, VignetteEffect, type Effect } from 'postprocessing'
import { ShaderMaterial, UnsignedByteType, type WebGLRenderTarget, type WebGLRenderer } from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { UI_ENTRANCE_EVENT } from '@/lib/uiEvents'
import { HalfFloatType, Vector2 } from 'three'
import { GL_DEBUG, glProbe, glx } from './debugGl'
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

/** Every this many frames the `?debug=gl` NaN scan reads the raw scene colour back (a full GPU sync: debug only). */
const NAN_SCAN_EVERY = 45

/** Half-float bits → non-finite? (exponent all ones) */
const halfNonFinite = (h: number) => (h & 0x7c00) === 0x7c00

/**
 * `?debug=gl` only: counts non-finite pixels in the raw scene colour (between the render pass and the sanitize pass),
 * so the panel can say whether a glitch is NaN-born. Reads the whole buffer back every NAN_SCAN_EVERY frames.
 */
class NanScanPass extends Pass {
  private n = 0
  private f32: Float32Array | null = null
  private u16: Uint16Array | null = null
  constructor() {
    super('NanScanPass')
    this.needsSwap = false
  }
  render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget | null) {
    if (!inputBuffer || ++this.n % NAN_SCAN_EVERY !== 0) return
    const g = renderer.getContext() as WebGL2RenderingContext
    const w = inputBuffer.width
    const h = inputBuffer.height
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(inputBuffer)
    try {
      const type = g.getParameter(g.IMPLEMENTATION_COLOR_READ_TYPE) as number
      let bad = 0
      let huge = 0
      if (type === g.HALF_FLOAT) {
        if (!this.u16 || this.u16.length !== w * h * 4) this.u16 = new Uint16Array(w * h * 4)
        g.readPixels(0, 0, w, h, g.RGBA, g.HALF_FLOAT, this.u16)
        const a = this.u16
        for (let i = 0; i < a.length; i += 4) if (halfNonFinite(a[i]) || halfNonFinite(a[i + 1]) || halfNonFinite(a[i + 2])) bad++
      } else {
        if (!this.f32 || this.f32.length !== w * h * 4) this.f32 = new Float32Array(w * h * 4)
        g.readPixels(0, 0, w, h, g.RGBA, g.FLOAT, this.f32)
        const a = this.f32
        for (let i = 0; i < a.length; i += 4) {
          const m = a[i] + a[i + 1] + a[i + 2]
          if (!Number.isFinite(m)) bad++
          else if (m > 192) huge++
        }
      }
      const err = g.getError()
      const nan = glProbe.nan
      nan.scans++
      nan.error = err ? `readPixels 0x${err.toString(16)}` : ''
      nan.lastBad = bad
      nan.lastHuge = huge
      nan.maxBad = Math.max(nan.maxBad, bad)
      if (bad) nan.framesWithBad++
    } catch (e) {
      glProbe.nan.error = String(e).slice(0, 80)
    } finally {
      renderer.setRenderTarget(prev)
    }
  }
}

/** Build the composer for this canvas and render it every frame. Returns it (for the shader warm-up). */
export function usePost(): EffectComposer {
  const rt = useRuntime()
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const dpr = useThree((s) => s.viewport.dpr)
  const { mobile } = rt.tier
  const msaa = GL_DEBUG && glx('msaa') ? 4 : msaaFor(rt.tier, dpr)

  const composer = useMemo(() => {
    const frameBufferType = GL_DEBUG && glx('u8') ? UnsignedByteType : HalfFloatType
    const c = new EffectComposer(gl, { multisampling: msaa, frameBufferType, stencilBuffer: false })
    c.addPass(new RenderPass(scene, camera))
    if (GL_DEBUG) c.addPass(new NanScanPass())
    if (!glx('nosanitize')) c.addPass(sanitizePass())
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
    const effects: Effect[] = glx('nobloom') ? [] : [bloom]
    c.addPass(new EffectPass(camera, ...effects, new ToneShoulderEffect(), noise, vignette))
    if (GL_DEBUG) glProbe.composer = c
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
    if (GL_DEBUG) glProbe.frames++
    if (GL_DEBUG && glx('nopost')) {
      // Straight to the canvas: three tone maps (none: the canvas is `flat`) and encodes sRGB itself.
      gl.setRenderTarget(null)
      gl.render(scene, camera)
    } else composer.render(delta)
    gl.autoClear = autoClear
  }, POST_PRIORITY)

  return composer
}
