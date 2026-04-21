import { useLoader } from '@react-three/fiber'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import {
  VRMAnimationLoaderPlugin,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation'

/**
 * Suspense-friendly loader for `.vrma` animation files.
 *
 * A `.vrma` is a GLTF whose `userData.vrmAnimations` array is populated by
 * `VRMAnimationLoaderPlugin`. We grab the first entry — VRoid-authored clips
 * contain exactly one.
 */
export function useVRMAnimationLoader(url: string): VRMAnimation {
  const gltf = useLoader(GLTFLoader, url, registerPlugins) as {
    userData: { vrmAnimations?: VRMAnimation[] }
  }
  const animation = gltf.userData.vrmAnimations?.[0]
  if (!animation)
    throw new Error(`[useVRMAnimationLoader] No VRMAnimation found in ${url}`)
  return animation
}

/**
 * Bulk version — loads all animations in parallel (r3f's `useLoader` accepts
 * a URL array and returns results in the same order).
 *
 * Use when:
 * - A character preset declares multiple clips up front. All clips fetch
 *   concurrently and the component Suspends until every one is ready.
 *
 * Expects:
 * - urls stays referentially stable across renders (changing the array on
 *   every render retriggers loads). In practice this is fine because the
 *   preset registry is module-level.
 */
export function useVRMAnimationsLoader(urls: readonly string[]): VRMAnimation[] {
  const gltfs = useLoader(GLTFLoader, urls as string[], registerPlugins) as Array<{
    userData: { vrmAnimations?: VRMAnimation[] }
  }>
  return gltfs.map((gltf, i) => {
    const anim = gltf.userData.vrmAnimations?.[0]
    if (!anim)
      throw new Error(`[useVRMAnimationsLoader] No VRMAnimation in ${urls[i]}`)
    return anim
  })
}

function registerPlugins(loader: GLTFLoader) {
  loader.register((parser) => new VRMLoaderPlugin(parser))
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
}
