/**
 * VRM preset registry.
 *
 * v1 is bundled-only (no user uploads). Add a new preset by dropping files
 * into /public/vrm/<id>/ and appending an entry here.
 *
 * Animation kinds:
 *  - 'idle'    — loops forever; exactly one per preset; the base layer
 *  - 'emotion' — paired with an `<|ACT:{"emotion":…}|>` marker from the LLM;
 *                plays for `holdMs` (default 3s) then fades back to idle
 *  - 'gesture' — triggered by `<|PLAY:id|>`; plays once for its clip duration
 *                then fades back to idle
 */
export interface VRMAnimationEntry {
  id: string;
  url: string;
  kind: 'idle' | 'emotion' | 'gesture';
  /**
   * For `kind === 'emotion'`: bind this clip to an ACT emotion name.
   * When the LLM emits `<|ACT:{"emotion":"<name>",…}|>`, the body clip
   * fires in lockstep with the facial expression.
   *
   * Opt-in — emotion clips without a binding can still be played
   * directly via `<|PLAY:id|>`.
   */
  emotion?: 'happy' | 'sad' | 'angry' | 'surprised' | 'relaxed' | 'neutral';
  /** Override default crossfade in seconds. @default 0.3 */
  crossfade?: number;
  /** For emotion kind: override hold duration in seconds. @default 3.0 */
  holdSeconds?: number;
}

export interface VRMPreset {
  id: string;
  name: string;
  modelUrl: string;
  previewUrl: string;
  animations: VRMAnimationEntry[];
  licence: string;
  defaultCameraOffset?: [number, number, number];
}

// ---------------------------------------------------------------------------
// Aria
// ---------------------------------------------------------------------------

const ARIA_ANIMATIONS: VRMAnimationEntry[] = [
  // Base layer — always under everything else.
  { id: 'idle', url: '/vrm/aria/animations/idle.vrma', kind: 'idle' },

  // Emotion clips — the body pose that pairs with each VRM facial preset.
  // `blush` stands in for `happy` (closest warm/affectionate pose in this set).
  { id: 'blush', url: '/vrm/aria/animations/blush.vrma', kind: 'emotion', emotion: 'happy' },
  { id: 'sad', url: '/vrm/aria/animations/sad.vrma', kind: 'emotion', emotion: 'sad' },
  { id: 'angry', url: '/vrm/aria/animations/angry.vrma', kind: 'emotion', emotion: 'angry' },
  { id: 'surprised', url: '/vrm/aria/animations/surprised.vrma', kind: 'emotion', emotion: 'surprised' },
  { id: 'relax', url: '/vrm/aria/animations/relax.vrma', kind: 'emotion', emotion: 'relaxed' },

  // Gestures — one-shots the LLM can invoke with `<|PLAY:id|>`.
  { id: 'clapping', url: '/vrm/aria/animations/clapping.vrma', kind: 'gesture' },
  { id: 'goodbye', url: '/vrm/aria/animations/goodbye.vrma', kind: 'gesture' },
  { id: 'jump', url: '/vrm/aria/animations/jump.vrma', kind: 'gesture' },
  { id: 'look_around', url: '/vrm/aria/animations/look_around.vrma', kind: 'gesture' },
  { id: 'thinking', url: '/vrm/aria/animations/thinking.vrma', kind: 'gesture' },
  { id: 'sleepy', url: '/vrm/aria/animations/sleepy.vrma', kind: 'gesture' },
  { id: 'dance', url: '/vrm/aria/animations/dance.vrma', kind: 'gesture' },
];

export const VRM_PRESETS: VRMPreset[] = [
  {
    id: 'aria',
    name: 'Aria',
    modelUrl: '/vrm/aria/model.vrm',
    previewUrl: '/vrm/aria/preview.png',
    animations: ARIA_ANIMATIONS,
    licence: 'CC-BY 4.0 — VRoid AvatarSample_A',
    defaultCameraOffset: [0, 1.3, 1.5],
  },
];

export const DEFAULT_PRESET_ID = VRM_PRESETS[0].id;

export function getPreset(id: string): VRMPreset {
  const preset = VRM_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`[presets] unknown preset id: ${id}`);
  return preset;
}
