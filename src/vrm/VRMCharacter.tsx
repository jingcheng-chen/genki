import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { VRMUtils, type VRM } from '@pixiv/three-vrm'
import { useVRMLoader } from '../hooks/useVRMLoader'
import { useVRMAnimationLoader } from '../hooks/useVRMAnimationLoader'
import { getPreset } from './presets'
import { buildIdleMixer, type IdleMixer } from './animation'
import {
  createBlinkController,
  createSaccadeController,
} from './idle-life'
import { getLipSyncDriver } from './lip-sync-driver'
import { getExpressionController } from './expression-controller'

interface Props {
  presetId: string
}

/**
 * Renders a VRM avatar with Phase 1 "idle life-signs":
 *
 *  - .vrma idle loop driving bone transforms (breathing, weight shift)
 *  - blinking every 3-6s with jitter
 *  - eye saccades (small random gaze shifts around the camera)
 *  - spring bone physics (hair/cloth sway), via vrm.update()
 *
 * Per-frame update order matters:
 *   1. mixer.update(delta)       — pose bones from .vrma
 *   2. blink.update(vrm, delta)  — set blink expression weight
 *   3. saccade.update(...)       — move lookAt target to camera + drift
 *   4. vrm.update(delta)         — commits humanoid + springBone + lookAt
 *                                  + expressionManager in one call
 */
export function VRMCharacter({ presetId }: Props) {
  const preset = getPreset(presetId)
  const gltf = useVRMLoader(preset.modelUrl)
  const vrm = gltf.userData.vrm
  const vrmRef = useRef<VRM>(vrm)

  const idleAnimation = useVRMAnimationLoader(preset.animations.idle)

  const { camera, scene } = useThree()

  const blink = useMemo(() => createBlinkController(), [])
  const saccade = useMemo(() => createSaccadeController(), [])
  const idleRef = useRef<IdleMixer | null>(null)

  useEffect(() => {
    vrmRef.current = vrm

    VRMUtils.removeUnnecessaryVertices(vrm.scene)
    VRMUtils.combineSkeletons(vrm.scene)

    // VRM 0.x: +Z forward. VRM 1.x: -Z forward. Flip legacy models.
    if (vrm.meta?.metaVersion === '0') {
      vrm.scene.rotation.y = Math.PI
    }

    // Attach the saccade target into the scene so lookAt can read its
    // world position reliably.
    scene.add(saccade.target)

    return () => {
      saccade.dispose()
      VRMUtils.deepDispose(vrm.scene)
    }
  }, [vrm, scene, saccade])

  useEffect(() => {
    const vrmInstance = vrmRef.current
    if (!vrmInstance || !idleAnimation) return

    const mixer = buildIdleMixer(vrmInstance, idleAnimation)
    idleRef.current = mixer

    return () => {
      mixer.dispose()
      idleRef.current = null
    }
  }, [vrm, idleAnimation])

  useFrame((_, delta) => {
    const v = vrmRef.current
    if (!v) return

    idleRef.current?.mixer.update(delta)
    blink(v, delta)
    saccade.update(v, camera, delta)

    // Emotion controller sets happy/sad/angry/etc. with ADSR + cross-fade.
    // Independent from lip-sync: this owns the upper-face presets, lip-sync
    // owns aa/ih/ou/ee/oh. No overlap, no fights.
    getExpressionController().update(v, delta)

    // Lip-sync reads wlipsync's current phoneme weights and sets aa/ih/ou/ee/oh.
    // Null until the user clicks "enable audio" in the debug panel.
    getLipSyncDriver()?.update(v, delta)

    v.update(delta)
  })

  return <primitive object={vrm.scene} />
}
