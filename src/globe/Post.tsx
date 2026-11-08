/**
 * Post (DESIGN.md §6): very mild bloom that only the signal marks and city-light cores reach (they are the
 * only things written above 1.0), a hue-preserving shoulder tone curve that leaves the ink / bone palette
 * exact (toneShoulder.ts), film grain within ±3%, a gentle vignette. No chromatic aberration, no lens flare.
 */
import { Bloom, EffectComposer, Noise, Vignette } from '@react-three/postprocessing'
import { BlendFunction } from 'postprocessing'
import { useEffect, useMemo } from 'react'
import { HalfFloatType } from 'three'
import { useRuntime } from './runtime'
import { ToneShoulderEffect } from './toneShoulder'

export function Post() {
  const rt = useRuntime()
  const { mobile, msaa } = rt.tier
  const tone = useMemo(() => new ToneShoulderEffect(), [])
  useEffect(() => () => tone.dispose(), [tone])
  return (
    <EffectComposer multisampling={msaa} frameBufferType={HalfFloatType} enableNormalPass={false} stencilBuffer={false}>
      <Bloom
        mipmapBlur
        luminanceThreshold={1.0}
        luminanceSmoothing={0.15}
        intensity={0.45}
        radius={0.62}
        levels={mobile ? 4 : 6}
      />
      <primitive object={tone} />
      {/* premultiply: output = colour × noise; NORMAL at 5.5% → luminance-proportional grain within ±3%. */}
      <Noise premultiply blendFunction={BlendFunction.NORMAL} opacity={0.055} />
      <Vignette offset={0.3} darkness={0.42} eskil={false} />
    </EffectComposer>
  )
}
