import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { Environment, OrbitControls } from '@react-three/drei'
import { VRMCharacter } from './VRMCharacter'
import { getPreset } from './presets'
import { useCharacterStore } from '../stores/character'

/**
 * Renders the active character. The `key` on VRMCharacter is the preset
 * id — switching characters unmounts the old component (which triggers
 * `VRMUtils.deepDispose` + animation controller teardown inside) and
 * mounts a fresh one against the new model URL. The inner Suspense
 * boundary means a character swap shows the "Loading avatar…" fallback
 * for the new VRM without blanking the whole Canvas / OrbitControls
 * state.
 */
export function Scene() {
  const activePresetId = useCharacterStore((s) => s.activePresetId)
  const preset = getPreset(activePresetId)
  const [camX, camY, camZ] = preset.defaultCameraOffset ?? [0, 1.3, 1.5]

  return (
    <Canvas
      shadows
      camera={{ position: [camX, camY, camZ], fov: 30, near: 0.1, far: 20 }}
      dpr={[1, 2]}
    >
      <ambientLight intensity={0.5} />
      <directionalLight
        position={[2, 4, 3]}
        intensity={2}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />
      <Environment preset="city" background={false} />

      <Suspense fallback={null}>
        <VRMCharacter key={preset.id} presetId={preset.id} />
      </Suspense>

      <OrbitControls
        target={[0, camY, 0]}
        enablePan={false}
        minDistance={0.8}
        maxDistance={4}
        minPolarAngle={Math.PI / 4}
        maxPolarAngle={(Math.PI * 3) / 4}
      />
    </Canvas>
  )
}
