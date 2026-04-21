import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { VRMUtils, type VRM } from '@pixiv/three-vrm'
import { useVRMLoader } from '../hooks/useVRMLoader'
import { useVRMAnimationsLoader } from '../hooks/useVRMAnimationLoader'
import { getPreset } from './presets'
import {
  createAnimationController,
  setActiveAnimationController,
  type AnimationController,
} from './animation-controller'
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
 * Renders a VRM avatar with the full Phase 1-4 life-sign stack:
 *
 *  - AnimationController: idle loop + emotion bodies + gesture one-shots
 *  - Blinking + eye saccades
 *  - Spring bone physics
 *  - Lip-sync driving aa/ih/ou/ee/oh from wlipsync weights
 *  - Expression controller driving upper-face emotion blendshapes
 *
 * Per-frame update order:
 *   1. animController.update(delta)    — advance mixer, handle overlay fade-back
 *   2. blink(vrm, delta)                — set blink expression
 *   3. saccade.update(...)              — move lookAt target
 *   4. expression.update(vrm, delta)    — set happy/sad/etc. facial presets
 *   5. lipSync.update(vrm, delta)       — set aa/ih/ou/ee/oh
 *   6. vrm.update(delta)                — commit humanoid + springBone + lookAt
 *                                         + expressionManager in one call
 */
export function VRMCharacter({ presetId }: Props) {
  const preset = getPreset(presetId)
  const gltf = useVRMLoader(preset.modelUrl)
  const vrm = gltf.userData.vrm
  const vrmRef = useRef<VRM>(vrm)

  // Preload every clip declared on the preset in parallel. Component
  // Suspends until all are ready — at 1.4MB total this is fast, and it
  // guarantees zero lag on the first emotion/gesture trigger.
  const animationUrls = useMemo(
    () => preset.animations.map((a) => a.url),
    [preset],
  )
  const animations = useVRMAnimationsLoader(animationUrls)

  const { camera, scene } = useThree()

  const blink = useMemo(() => createBlinkController(), [])
  const saccade = useMemo(() => createSaccadeController(), [])
  const animRef = useRef<AnimationController | null>(null)

  useEffect(() => {
    vrmRef.current = vrm

    VRMUtils.removeUnnecessaryVertices(vrm.scene)
    VRMUtils.combineSkeletons(vrm.scene)

    // VRM 0.x: +Z forward. VRM 1.x: -Z forward. Flip legacy models.
    if (vrm.meta?.metaVersion === '0') {
      vrm.scene.rotation.y = Math.PI
    }

    scene.add(saccade.target)

    return () => {
      saccade.dispose()
      VRMUtils.deepDispose(vrm.scene)
    }
  }, [vrm, scene, saccade])

  useEffect(() => {
    const v = vrmRef.current
    if (!v) return
    const controller = createAnimationController(v, preset.animations, animations)
    animRef.current = controller
    setActiveAnimationController(controller)

    return () => {
      setActiveAnimationController(null)
      controller.dispose()
      animRef.current = null
    }
  }, [vrm, preset, animations])

  useFrame((_, delta) => {
    const v = vrmRef.current
    if (!v) return

    animRef.current?.update(delta)
    blink(v, delta)
    saccade.update(v, camera, delta)
    getExpressionController().update(v, delta)
    getLipSyncDriver()?.update(v, delta)

    v.update(delta)
  })

  return <primitive object={vrm.scene} />
}
