import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Environment, OrbitControls } from '@react-three/drei'
import {
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  type AnimationAction,
  type AnimationClip,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation'
import { Transport } from './Transport'

interface Props {
  vrmUrl: string | null
  animationUrl: string | null
  animationName: string | null
  playing: boolean
  loop: boolean
  onTogglePlaying: () => void
  onToggleLoop: () => void
  onPrev: () => void
  onNext: () => void
}

interface PreviewState {
  duration: number
  time: number
  finished: boolean
}

export function PreviewPane(props: Props) {
  const [state, setState] = useState<PreviewState>({
    duration: 0,
    time: 0,
    finished: false,
  })
  const [scrubTo, setScrubTo] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Stable callback so the inner Suspense child doesn't re-effect on every
  // PreviewPane render (state updates fire 10x/sec during playback).
  const onState = useCallback((s: PreviewState) => setState(s), [])
  const onError = useCallback((msg: string | null) => setError(msg), [])

  // Reset error when inputs change so a fresh attempt isn't blocked by a
  // stale "broken VRMA" message.
  useEffect(() => {
    setError(null)
  }, [props.vrmUrl, props.animationUrl])

  return (
    <section className="flex flex-col min-w-0 overflow-hidden bg-[#0b0d12]">
      <div className="relative flex-1 min-h-0">
        {props.vrmUrl ? (
          <Canvas
            shadows
            camera={{ position: [0, 1.3, 1.5], fov: 30, near: 0.1, far: 20 }}
            dpr={[1, 2]}
          >
            <ambientLight intensity={0.6} />
            <directionalLight
              position={[2, 4, 3]}
              intensity={2}
              castShadow
              shadow-mapSize={[1024, 1024]}
            />
            <Environment preset="city" background={false} />
            <Suspense fallback={null}>
              <PreviewCharacter
                key={props.vrmUrl}
                vrmUrl={props.vrmUrl}
                animationUrl={props.animationUrl}
                playing={props.playing}
                loop={props.loop}
                scrubTo={scrubTo}
                onState={onState}
                onError={onError}
              />
            </Suspense>
            <OrbitControls
              target={[0, 1.0, 0]}
              enablePan
              minDistance={0.5}
              maxDistance={6}
            />
          </Canvas>
        ) : (
          <Empty>Pick a model to preview</Empty>
        )}
        {error ? (
          <div className="absolute bottom-3 left-3 right-3 px-3 py-2 text-xs bg-rose-900/80 text-rose-100 border border-rose-700 rounded font-mono">
            {error}
          </div>
        ) : null}
      </div>
      <Transport
        animationName={props.animationName}
        playing={props.playing}
        loop={props.loop}
        time={state.time}
        duration={state.duration}
        onTogglePlaying={props.onTogglePlaying}
        onToggleLoop={props.onToggleLoop}
        onPrev={props.onPrev}
        onNext={props.onNext}
        onScrub={setScrubTo}
      />
    </section>
  )
}

interface CharProps {
  vrmUrl: string
  animationUrl: string | null
  playing: boolean
  loop: boolean
  scrubTo: number | null
  onState: (s: PreviewState) => void
  onError: (msg: string | null) => void
}

function PreviewCharacter({
  vrmUrl,
  animationUrl,
  playing,
  loop,
  scrubTo,
  onState,
  onError,
}: CharProps) {
  const [vrm, setVrm] = useState<VRM | null>(null)
  const mixerRef = useRef<AnimationMixer | null>(null)
  const actionRef = useRef<AnimationAction | null>(null)
  const clipRef = useRef<AnimationClip | null>(null)
  const lastEmitRef = useRef(0)

  // -------------------------------------------------------------------------
  // Load VRM. Fresh GLTFLoader each time — bypassing the R3F cache so a file
  // that was rewritten on disk is actually re-fetched.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    let loaded: VRM | null = null

    const loader = new GLTFLoader()
    loader.register((p) => new VRMLoaderPlugin(p))
    loader.register((p) => new VRMAnimationLoaderPlugin(p))

    loader
      .loadAsync(vrmUrl)
      .then((gltf) => {
        const v = (gltf.userData as { vrm?: VRM }).vrm
        if (!v) {
          if (!cancelled) onError(`No VRM payload in ${vrmUrl}`)
          return
        }
        if (cancelled) {
          VRMUtils.deepDispose(v.scene)
          return
        }
        VRMUtils.removeUnnecessaryVertices(v.scene)
        VRMUtils.combineSkeletons(v.scene)
        if (v.meta?.metaVersion === '0') v.scene.rotation.y = Math.PI
        loaded = v
        setVrm(v)
      })
      .catch((err) => {
        if (cancelled) return
        onError(`VRM load failed: ${err instanceof Error ? err.message : String(err)}`)
      })

    return () => {
      cancelled = true
      // Tear down mixer + actions before disposing the underlying scene —
      // the mixer holds references to clips that are bound to bones in the
      // VRM scene.
      mixerRef.current?.stopAllAction()
      mixerRef.current = null
      actionRef.current = null
      clipRef.current = null
      if (loaded) VRMUtils.deepDispose(loaded.scene)
      setVrm(null)
    }
  }, [vrmUrl, onError])

  // -------------------------------------------------------------------------
  // Mixer follows the VRM. Recreated whenever the VRM changes.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!vrm) return
    const mixer = new AnimationMixer(vrm.scene)
    mixerRef.current = mixer
    return () => {
      mixer.stopAllAction()
      mixerRef.current = null
      actionRef.current = null
      clipRef.current = null
    }
  }, [vrm])

  // -------------------------------------------------------------------------
  // Load + attach the selected animation. Loop / playing flag are applied
  // here AND by their own focused effects below — so a reload picks up the
  // latest values, but flipping a flag mid-playback doesn't re-fetch.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const mixer = mixerRef.current
    if (!vrm || !mixer || !animationUrl) {
      if (actionRef.current) {
        actionRef.current.stop()
        if (clipRef.current) mixer?.uncacheClip(clipRef.current)
        actionRef.current = null
        clipRef.current = null
      }
      return
    }

    let cancelled = false
    const loader = new GLTFLoader()
    loader.register((p) => new VRMLoaderPlugin(p))
    loader.register((p) => new VRMAnimationLoaderPlugin(p))

    loader
      .loadAsync(animationUrl)
      .then((gltf) => {
        if (cancelled) return
        const anims = (gltf.userData as { vrmAnimations?: VRMAnimation[] }).vrmAnimations
        const anim = anims?.[0]
        if (!anim) {
          onError(`No VRMAnimation in ${animationUrl}`)
          return
        }
        if (actionRef.current) {
          actionRef.current.stop()
          if (clipRef.current) mixer.uncacheClip(clipRef.current)
        }
        const clip = createVRMAnimationClip(anim, vrm)
        const action = mixer.clipAction(clip)
        action.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1)
        action.clampWhenFinished = true
        action.reset()
        action.play()
        action.paused = !playing
        clipRef.current = clip
        actionRef.current = action
      })
      .catch((err) => {
        if (cancelled) return
        onError(`VRMA load failed: ${err instanceof Error ? err.message : String(err)}`)
      })

    return () => {
      cancelled = true
      if (actionRef.current) {
        actionRef.current.stop()
        if (clipRef.current) mixer.uncacheClip(clipRef.current)
        actionRef.current = null
        clipRef.current = null
      }
    }
    // playing/loop are intentionally NOT deps — see the focused effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vrm, animationUrl])

  // -------------------------------------------------------------------------
  // Cheap state pokes that shouldn't re-attach the action.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (actionRef.current) actionRef.current.paused = !playing
  }, [playing])

  useEffect(() => {
    const a = actionRef.current
    if (!a) return
    a.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1)
    a.clampWhenFinished = true
  }, [loop])

  useEffect(() => {
    if (scrubTo == null) return
    const a = actionRef.current
    const m = mixerRef.current
    if (!a || !m) return
    a.time = scrubTo
    // Apply the seek immediately so the pose updates even while paused.
    m.update(0)
  }, [scrubTo])

  // -------------------------------------------------------------------------
  // Per-frame: advance mixer + VRM. Throttle the upward state pokes to 10Hz
  // so the parent doesn't get hammered by the frame loop.
  // -------------------------------------------------------------------------
  useFrame((_, delta) => {
    if (mixerRef.current) mixerRef.current.update(delta)
    if (vrm) vrm.update(delta)
    const a = actionRef.current
    const c = clipRef.current
    if (!a || !c) return
    const now = performance.now()
    if (now - lastEmitRef.current < 100) return
    lastEmitRef.current = now
    onState({
      duration: c.duration,
      time: a.time,
      finished: !a.isRunning() && a.time >= c.duration - 0.001,
    })
  })

  if (!vrm) return null
  return <primitive object={vrm.scene} />
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
      {children}
    </div>
  )
}
