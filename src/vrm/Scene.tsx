import { Canvas } from '@react-three/fiber'
import { Environment, OrbitControls } from '@react-three/drei'
import { VRMCharacter } from './VRMCharacter'
import { DEFAULT_PRESET_ID, getPreset } from './presets'

export function Scene() {
  const preset = getPreset(DEFAULT_PRESET_ID)
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

      <VRMCharacter presetId={preset.id} />

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
