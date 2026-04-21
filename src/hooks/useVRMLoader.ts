import { useLoader } from '@react-three/fiber'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  VRMLoaderPlugin,
  type VRM,
} from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation'

/**
 * Loads a .vrm file via drei-style Suspense caching.
 *
 * Registers both VRMLoaderPlugin (for .vrm) and VRMAnimationLoaderPlugin
 * (for .vrma) on the same GLTFLoader instance, so the returned loader
 * can be reused for animation files.
 *
 * @returns the parsed GLTF; `.userData.vrm` is the VRM instance.
 */
export function useVRMLoader(url: string): GLTF & { userData: { vrm: VRM } } {
  return useLoader(GLTFLoader, url, (loader) => {
    loader.register((parser) => new VRMLoaderPlugin(parser))
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
  }) as GLTF & { userData: { vrm: VRM } }
}
