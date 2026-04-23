import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { VRMUtils, type VRM } from '@pixiv/three-vrm'
import { useSceneStore } from '../stores/scene'

// NOTICE:
// `VRMUtils.removeUnnecessaryVertices` and `VRMUtils.combineSkeletons`
// mutate the VRM scene in place. R3F's `useLoader(GLTFLoader, url)` caches
// the parsed GLTF by URL, so when the user swaps characters and swaps
// back, the same VRM instance comes out of the cache — and if we run
// these prep ops a second time on the already-prepared scene, the
// skeleton bindings and geometry index get corrupted (the mesh stops
// rendering even though `vrm.scene` is still in the three.js graph).
//
// Track which VRMs we've already prepared with a weak set so the prep
// happens exactly once per VRM instance for the lifetime of the cache.
const PREPARED_VRMS = new WeakSet<VRM>()
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
import { createFpsSampler } from '../observability/fps'

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
  const fpsSampler = useMemo(() => createFpsSampler(), [])
  const animRef = useRef<AnimationController | null>(null)

  useEffect(() => {
    vrmRef.current = vrm

    if (!PREPARED_VRMS.has(vrm)) {
      VRMUtils.removeUnnecessaryVertices(vrm.scene)
      VRMUtils.combineSkeletons(vrm.scene)

      // VRM 0.x: +Z forward. VRM 1.x: -Z forward. Flip legacy models.
      if (vrm.meta?.metaVersion === '0') {
        vrm.scene.rotation.y = Math.PI
      }

      PREPARED_VRMS.add(vrm)
    }

    // NOTICE:
    // R3F's <primitive> detach path flips `object.visible = false` when the
    // component unmounts. Because `useLoader` caches the GLTF by URL, the
    // same `vrm.scene` object comes back on the next mount still hidden,
    // so we force visibility on every mount.
    vrm.scene.visible = true

    scene.add(saccade.target)

    return () => {
      saccade.dispose()
      // NOTICE:
      // Don't call `VRMUtils.deepDispose(vrm.scene)` here. The GLTF is
      // cached by R3F's `useLoader(GLTFLoader, url)`, so when the user
      // switches characters and then switches BACK, the cached VRM is
      // returned again — with a scene whose geometries/materials we'd
      // just freed, producing an empty render.
      // If we ever need to reclaim that GPU memory (e.g. more than a
      // handful of characters in the registry), clear the R3F loader
      // cache for this URL at the same time we deepDispose.
    }
  }, [vrm, scene, saccade])

  useEffect(() => {
    const v = vrmRef.current
    if (!v) return
    // Phase 10 — announce the VRM side of the boot handshake. The hooks
    // above have already resolved (otherwise we wouldn't be running this
    // effect), so fetch progress is at 100% and we're in the synchronous
    // wire-up phase. `binding` -> `ready` is expected to happen within
    // one frame for all practical models. We only fire this on the first
    // load of the session; subsequent character swaps keep us in `ready`
    // since the StartGate is already dismissed.
    const sceneStore = useSceneStore.getState()
    if (sceneStore.status !== 'ready') {
      sceneStore.setVrmProgress(1)
      sceneStore.setStatus('binding')
    }
    const controller = createAnimationController(v, preset.animations, animations)
    animRef.current = controller
    setActiveAnimationController(controller)
    // Animation controller allocated, first expression apply will happen
    // on the first useFrame tick. Mark ready now so the StartGate can
    // enable its Start button; the render loop picks up from here.
    if (useSceneStore.getState().status !== 'ready') {
      useSceneStore.getState().setStatus('ready')
    }

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

    // Dev-only FPS sample at ~1Hz. No-op in production via the tracer
    // gate, so this line is free when bundled.
    fpsSampler(delta)
  })

  return <primitive object={vrm.scene} />
}
