/**
 * The Earth mesh (fixed in the Earth-fixed frame; the sun moves, the planet doesn't) and its cloud shell.
 * Textures arrive progressively; materials re-bind on every upgrade. If textures fail entirely, an ink
 * sphere with a hairline graticule keeps the scene honest and usable.
 * Phones compile the Earth and cloud shaders with LITE (fewer texture fetches, PERF-08). The cloud shell reuses
 * the Earth's sphere (scaled), and the soft atmosphere shell is low-poly (PERF-17).
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { BackSide, AdditiveBlending, Color, ShaderMaterial, SphereGeometry, Vector2, type BufferGeometry } from 'three'
import { palette } from '@/ui/system/palette'
import { atmosphereFragment, atmosphereVertex } from './shaders/atmosphere'
import { cloudsFragment, cloudsVertex } from './shaders/clouds'
import { earthFallbackFragment, earthFragment, earthVertex } from './shaders/earth'
import { FRAME, useRuntime, type GlobeRuntime } from './runtime'
import type { EarthTextures } from './textures'

import { lin } from './materials'

export { lin }

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

export function useSphere(segments: number) {
  const geo = useMemo(() => new SphereGeometry(1, segments, Math.round(segments / 2)), [segments])
  useEffect(() => () => geo.dispose(), [geo])
  return geo
}

/** The painted-imagery uniforms (chunks.ts PAINT), shared by reference so one write updates both shells. */
function paintUniforms(rt: GlobeRuntime) {
  const p = rt.paint
  return {
    uCtxMap: p.uCtxMap,
    uCtxUv: p.uCtxUv,
    uCtxOn: p.uCtxOn,
    uCtxLod: p.uCtxLod,
    uDecalMap: p.uDecalMap,
    uDecalUv: p.uDecalUv,
    uDecalOn: p.uDecalOn,
    uDecal2Map: p.uDecal2Map,
    uDecal2Uv: p.uDecal2Uv,
    uDecal2On: p.uDecal2On,
    uScanT0: p.uScanT0,
    uScanS: p.uScanS,
    uFull: p.uFull,
    uFreshRad: p.uFreshRad,
  }
}

/** Shader defines for the device tier. */
const tierDefines = (mobile: boolean): Record<string, string> => (mobile ? { LITE: '' } : {})

export function Earth({ textures, geometry }: { textures: EarthTextures; geometry: BufferGeometry }) {
  const rt = useRuntime()
  const material = useMemo(
    () =>
      new ShaderMaterial({
        defines: tierDefines(rt.tier.mobile),
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
          ...paintUniforms(rt),
          uFreshColor: { value: lin(palette.signal) },
          uPanelHalf: rt.paint.uPanelHalf,
          uDayLod: rt.paint.uDayLod,
          uPanelColor: { value: lin(palette.bone) },
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

export function Clouds({ textures, geometry }: { textures: EarthTextures; geometry: BufferGeometry }) {
  const rt = useRuntime()
  const material = useMemo(
    () =>
      new ShaderMaterial({
        defines: tierDefines(rt.tier.mobile),
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
          ...paintUniforms(rt),
          uCloudFade: rt.paint.uCloudFade,
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
    // Overlays (the swath ribbon) read cloud cover from the same map.
    rt.uniforms.uCloudMap.value = textures.clouds
    const u = material.uniforms.uOpacity
    if (u.value < 1) u.value = Math.min(1, u.value + dt / (rt.reducedMotion ? 0.2 : 1.6))
  }, FRAME.scene)

  return <mesh geometry={geometry} material={material} scale={CLOUD_RADIUS} renderOrder={1} />
}

export function Atmosphere() {
  const rt = useRuntime()
  // A soft back-face shell: 64×32 is plenty and builds in a fraction of the time.
  const geometry = useSphere(64)
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
