import { AnimationMixer, type AnimationAction } from 'three'
import type { VRM } from '@pixiv/three-vrm'
import {
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation'

/**
 * Builds an AnimationMixer playing a single VRMA clip on the given VRM.
 *
 * Use when:
 * - Attaching an idle loop (breathing, weight shift) to a freshly loaded VRM
 *
 * Expects:
 * - vrm.scene already mounted in the render tree; caller will drive
 *   mixer.update(delta) inside useFrame
 *
 * Returns:
 * - mixer  — call update(delta) each frame
 * - action — the active AnimationAction for tweaking weight/fade
 * - dispose — detach and free clip caches (call on VRM change / unmount)
 */
export interface IdleMixer {
  mixer: AnimationMixer
  action: AnimationAction
  dispose: () => void
}

export function buildIdleMixer(vrm: VRM, animation: VRMAnimation): IdleMixer {
  const clip = createVRMAnimationClip(animation, vrm)
  const mixer = new AnimationMixer(vrm.scene)
  const action = mixer.clipAction(clip)
  action.play()

  return {
    mixer,
    action,
    dispose: () => {
      action.stop()
      mixer.stopAllAction()
      mixer.uncacheClip(clip)
      mixer.uncacheRoot(vrm.scene)
    },
  }
}
