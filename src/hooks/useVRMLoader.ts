import { useLoader } from '@react-three/fiber'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  VRMLoaderPlugin,
  type VRM,
} from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation'
import { useSceneStore } from '../stores/scene'

/**
 * Loads a .vrm file via drei-style Suspense caching.
 *
 * Registers both VRMLoaderPlugin (for .vrm) and VRMAnimationLoaderPlugin
 * (for .vrma) on the same GLTFLoader instance, so the returned loader
 * can be reused for animation files.
 *
 * Publishes load-progress to the scene store so the StartGate can show
 * a progress bar. We only report progress when `total` is known (HEAD
 * request returned Content-Length); otherwise we leave the bar at its
 * last value rather than flicker to 0%.
 *
 * @returns the parsed GLTF; `.userData.vrm` is the VRM instance.
 */
export function useVRMLoader(url: string): GLTF & { userData: { vrm: VRM } } {
  // NOTICE:
  // In @react-three/fiber v9, useLoader's return type changed to
  // `GLTF & ObjectMap` which no longer overlaps with our narrower
  // `{ userData: { vrm: VRM } }` claim (ObjectMap types userData as
  // Record<string, any>). The runtime shape is unchanged — the VRM
  // plugin still stashes the VRM instance on userData.vrm — so we
  // widen through `unknown` to preserve the caller-facing contract.
  // Root cause: @react-three/fiber 9.x ObjectMap userData typing.
  // Source: node_modules/@react-three/fiber/dist/declarations/src/core/utils.d.ts
  // Removal: when fiber exposes a way to augment GLTF's userData type.
  return useLoader(
    GLTFLoader,
    url,
    (loader) => {
      loader.register((parser) => new VRMLoaderPlugin(parser))
      loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
    },
    (ev) => reportVrmProgress(ev),
  ) as unknown as GLTF & { userData: { vrm: VRM } }
}

/**
 * Forward a three.js loader progress event to the scene store.
 *
 * Use when:
 * - Any VRM/VRMA loader wants to contribute to the cold-start progress
 *   bar the StartGate reads.
 *
 * Expects:
 * - ev.lengthComputable === true when `total > 0`; otherwise we skip the
 *   update rather than render a confusing 0% jump.
 */
export function reportVrmProgress(ev: ProgressEvent<EventTarget>): void {
  if (!ev.lengthComputable || ev.total <= 0) return
  const store = useSceneStore.getState()
  // Only drive the loading-vrm progression during cold start. Once the
  // StartGate has dismissed we're in `ready` and a character switch shouldn't
  // demote us back to loading — the gate doesn't come back mid-session.
  if (store.status === 'ready' || store.status === 'error') return
  if (store.status !== 'loading-vrm') {
    store.setStatus('loading-vrm')
  }
  const frac = Math.max(0, Math.min(1, ev.loaded / ev.total))
  // Don't let progress go backwards inside the same load — three.js will
  // report multiple sub-resources, each with its own ProgressEvent. We
  // want a monotonically-increasing bar as the character becomes visible.
  if (frac > store.vrmProgress) {
    store.setVrmProgress(frac)
  }
}
