import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { VRMUtils, type VRM } from '@pixiv/three-vrm'
import { useVRMLoader } from '../hooks/useVRMLoader'
import { getPreset } from './presets'

interface Props {
  presetId: string
}

/**
 * Renders a VRM avatar from a bundled preset.
 *
 * Phase 0: model loads, orients toward camera, and runs the per-frame
 * humanoid/springBone/lookAt pipeline. No animations or expressions yet —
 * those land in Phase 1/2/3.
 */
export function VRMCharacter({ presetId }: Props) {
  const preset = getPreset(presetId)
  const gltf = useVRMLoader(preset.modelUrl)
  const vrm = gltf.userData.vrm
  const vrmRef = useRef<VRM>(vrm)

  useEffect(() => {
    vrmRef.current = vrm

    // Optimization: merge morph targets where safe, remove unused joints.
    VRMUtils.removeUnnecessaryVertices(vrm.scene)
    VRMUtils.combineSkeletons(vrm.scene)

    // VRM 0.x was +Z forward, VRM 1.x is -Z forward. Rotate legacy models
    // 180° so they face the default camera position. No-op for VRM 1.x.
    if (vrm.meta?.metaVersion === '0') {
      vrm.scene.rotation.y = Math.PI
    }

    return () => {
      VRMUtils.deepDispose(vrm.scene)
    }
  }, [vrm])

  useFrame((_, delta) => {
    const v = vrmRef.current
    if (!v) return
    v.update(delta)
  })

  return <primitive object={vrm.scene} />
}
