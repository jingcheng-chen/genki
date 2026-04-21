/**
 * VRM preset registry.
 *
 * v1 is bundled-only (no user uploads). Add a new preset by dropping files
 * into /public/vrm/<id>/ and appending an entry here.
 *
 * Each preset points at:
 *  - modelUrl: the .vrm file
 *  - previewUrl: a thumbnail PNG for pickers
 *  - animations.idle: a .vrma idle loop (required)
 *  - animations.*:    optional action clips (greet, wave, think, …)
 */
export interface VRMPreset {
  id: string
  name: string
  modelUrl: string
  previewUrl: string
  animations: {
    idle: string
    greet?: string
    wave?: string
    think?: string
  }
  licence: string
  defaultCameraOffset?: [number, number, number]
}

export const VRM_PRESETS: VRMPreset[] = [
  {
    id: 'aria',
    name: 'Aria',
    modelUrl: '/vrm/aria/model.vrm',
    previewUrl: '/vrm/aria/preview.png',
    animations: {
      idle: '/vrm/aria/animations/idle.vrma',
    },
    licence: 'VRoid AvatarSample_A — royalty-free sample from Pixiv',
    defaultCameraOffset: [0, 1.3, 1.5],
  },
]

export const DEFAULT_PRESET_ID = VRM_PRESETS[0].id

export function getPreset(id: string): VRMPreset {
  const preset = VRM_PRESETS.find((p) => p.id === id)
  if (!preset) throw new Error(`[presets] unknown preset id: ${id}`)
  return preset
}
