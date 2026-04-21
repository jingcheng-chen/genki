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
  const gltf = useLoader(GLTFLoader, url, (loader) => {
    loader.register((parser) => new VRMLoaderPlugin(parser))
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
  }) as { userData: { vrmAnimations?: VRMAnimation[] } }

  const animation = gltf.userData.vrmAnimations?.[0]
  if (!animation)
    throw new Error(`[useVRMAnimationLoader] No VRMAnimation found in ${url}`)
  return animation
}
