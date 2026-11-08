/**
 * The Earth mesh (fixed in the Earth-fixed frame; the sun moves, the planet doesn't) and its cloud shell.
 * Textures arrive progressively; materials re-bind on every upgrade. If textures fail entirely, an ink
 * sphere with a hairline graticule keeps the scene honest and usable.
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { BackSide, AdditiveBlending, Color, ShaderMaterial, SphereGeometry, Vector2 } from 'three'
import { palette } from '@/ui/system/palette'
import { atmosphereFragment, atmosphereVertex } from './shaders/atmosphere'
import { cloudsFragment, cloudsVertex } from './shaders/clouds'
import { earthFallbackFragment, earthFragment, earthVertex } from './shaders/earth'
import { FRAME, useRuntime } from './runtime'
import type { EarthTextures } from './textures'

/** Linear-space colour from a palette hex (three converts sRGB hex → linear working space). */
export const lin = (hex: string) => new Color(hex)

export const CLOUD_RADIUS = 1.006
export const ATMOSPHERE_RADIUS = 1.025
/** Sun irradiance multiplier for the day side (linear). Tuned so ice caps stay under the bloom threshold. */
const SUN_INTENSITY = 1.08

/** Shared fade-in for the planet layers. */
function useReveal(material: ShaderMaterial | null, durationS: number) {
  const rt = useRuntime()
  useFrame((_, dt) => {
    if (!material) return
    const u = material.uniforms.uReveal
    if (u.value < 1) u.value = Math.min(1, u.value + dt / (rt.reducedMotion ? 0.2 : durationS))
  }, FRAME.scene)
}

function useSphere(segments: number) {
  const geo = useMemo(() => new SphereGeometry(1, segments, Math.round(segments / 2)), [segments])
  useEffect(() => () => geo.dispose(), [geo])
  return geo
}

export function Earth({ textures }: { textures: EarthTextures }) {
  const rt = useRuntime()
  const geometry = useSphere(rt.tier.sphereSegments)
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: earthVertex,
        fragmentShader: earthFragment,
        uniforms: {
          uDay: { value: textures.day },
          uNight: { value: textures.night },
          uClouds: { value: textures.clouds },
          uData: { value: textures.data },
          uDataTexel: { value: new Vector2(1 / 1024, 1 / 512) },
          uSunDir: rt.uniforms.uSunDir,
          uCloudOffset: rt.uniforms.uCloudOffset,
          uSunIntensity: { value: SUN_INTENSITY },
          uBump: { value: 0.01 },
          uCloudHeight: { value: CLOUD_RADIUS - 1 },
          uCityColor: { value: lin(palette.cityLights) },
          uTwilightColor: { value: lin(palette.terminator) },
          uHazeColor: { value: lin('#b4cde6') },
          uNightTint: { value: new Color(0.86, 0.92, 1.0) },
          uReveal: { value: 0 },
        },
      }),
    // Created once; textures are re-bound below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  useEffect(() => () => material.dispose(), [material])

  // Re-bind after progressive upgrades (by identity, every frame, before rendering).
  useFrame(() => {
    const u = material.uniforms
    if (u.uDay.value !== textures.day) u.uDay.value = textures.day
    if (u.uNight.value !== textures.night) u.uNight.value = textures.night
    if (u.uClouds.value !== textures.clouds) u.uClouds.value = textures.clouds
    if (u.uData.value !== textures.data) {
      u.uData.value = textures.data
      const img = textures.data.image as { width?: number; height?: number } | undefined
      if (img?.width && img.height) u.uDataTexel.value.set(1 / img.width, 1 / img.height)
    }
  }, FRAME.scene)

  useReveal(material, 1.1)
  return <mesh geometry={geometry} material={material} renderOrder={0} />
}

export function EarthFallback() {
  const rt = useRuntime()
  const geometry = useSphere(96)
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: earthVertex,
        fragmentShader: earthFallbackFragment,
        uniforms: {
          uSunDir: rt.uniforms.uSunDir,
          uLine: { value: lin(palette.bone) },
          uInk: { value: lin(palette.ink2) },
        },
      }),
    [rt],
  )
  useEffect(() => () => material.dispose(), [material])
  return <mesh geometry={geometry} material={material} />
}

export function Clouds({ textures }: { textures: EarthTextures }) {
  const rt = useRuntime()
  const geometry = useSphere(Math.round(rt.tier.sphereSegments * 0.75))
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: cloudsVertex,
        fragmentShader: cloudsFragment,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uClouds: { value: textures.clouds },
          uTexel: { value: new Vector2(1 / 1024, 1 / 512) },
          uSunDir: rt.uniforms.uSunDir,
          uCloudOffset: rt.uniforms.uCloudOffset,
          uSunIntensity: { value: SUN_INTENSITY },
          uCloudColor: { value: lin('#e4e3de') },
          uTwilightColor: { value: lin(palette.terminator) },
          uNightColor: { value: lin(palette.ink1) },
          uOpacity: { value: 0 },
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  useEffect(() => () => material.dispose(), [material])
  useFrame((_, dt) => {
    if (material.uniforms.uClouds.value !== textures.clouds) {
      material.uniforms.uClouds.value = textures.clouds
      const img = textures.clouds.image as { width?: number; height?: number } | undefined
      if (img?.width && img.height) material.uniforms.uTexel.value.set(1 / img.width, 1 / img.height)
    }
    const u = material.uniforms.uOpacity
    if (u.value < 1) u.value = Math.min(1, u.value + dt / (rt.reducedMotion ? 0.2 : 1.6))
  }, FRAME.scene)

  return <mesh geometry={geometry} material={material} scale={CLOUD_RADIUS} renderOrder={1} />
}

export function Atmosphere() {
  const rt = useRuntime()
  const geometry = useSphere(128)
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: atmosphereVertex,
        fragmentShader: atmosphereFragment,
        side: BackSide,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {
          uSunDir: rt.uniforms.uSunDir,
          uShell: { value: ATMOSPHERE_RADIUS },
          uScaleHeight: { value: 0.0042 },
          uRayleigh: { value: lin('#8fb4ec') },
          uHorizon: { value: lin('#dfe9f5') },
          uTwilightColor: { value: lin(palette.terminator) },
          uIntensity: { value: 0.85 },
          uReveal: { value: 0 },
        },
      }),
    [rt],
  )
  useEffect(() => () => material.dispose(), [material])
  useReveal(material, 1.4)
  return <mesh geometry={geometry} material={material} scale={ATMOSPHERE_RADIUS} renderOrder={-1} />
}
