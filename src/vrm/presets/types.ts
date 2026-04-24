/**
 * Shared types for VRM character presets.
 *
 * Separated from `index.ts` so per-character files can depend on the
 * shapes without pulling in the full preset registry (and vice versa).
 */

import type { EmotionName } from '../emotion-vocab'

/**
 * A single outfit variant of a character's VRM model. A preset ships one or
 * more variants; `defaultModelId` picks which one loads by default.
 *
 * Long-term this lets the user (or the romance-meter / hidden-goals system
 * from the reference config) swap outfits at runtime. Today only the
 * default is used.
 */
export interface VRMModelVariant {
  /** Stable id — e.g. 'default', 'casual', 'school_uniform'. */
  id: string
  /** Display name for a future outfit-swap UI. */
  label: string
  /** Public-served VRM url, e.g. '/vrm/shiro/models/shiro_casual.vrm'. */
  url: string
}

/**
 * One animation clip in a preset's library.
 *
 *  - 'idle'    — loops forever; exactly one per preset; the default base layer
 *  - 'emotion' — paired with an `<|ACT:{"emotion":…}|>` marker from the
 *                LLM; plays for `holdSeconds` (default 3s) then fades back
 *                to the current base. `emotion` must be one of the 6 VRM
 *                primaries.
 *  - 'gesture' — triggered by `<|PLAY:id|>`; plays once then fades back to
 *                the current base
 *  - 'talking' — speaking-idle variants. Invisible to the LLM. The
 *                animation controller randomly picks one while the turn
 *                controller is in the 'speaking' state and chains the
 *                next variant whenever the current clip finishes, until
 *                speaking ends. A preset with zero 'talking' clips simply
 *                stays on the regular idle during speech.
 */
export interface VRMAnimationEntry {
  id: string
  url: string
  kind: 'idle' | 'emotion' | 'gesture' | 'talking'
  /**
   * For `kind === 'emotion'`: bind this clip to an ACT emotion primary.
   * Opt-in — emotion clips without a binding can still be played directly
   * via `<|PLAY:id|>`.
   */
  emotion?: EmotionName
  /** Override default crossfade in seconds. @default 0.3 */
  crossfade?: number
  /** For emotion kind: override hold duration in seconds. @default 3.0 */
  holdSeconds?: number
}

export interface VRMPreset {
  id: string
  /** Display name shown in the character picker. */
  name: string
  /** One-line descriptor for the picker card. */
  tagline: string
  /**
   * Outfit variants. At least one entry must match `defaultModelId`.
   *
   * The folder convention is `/public/vrm/<preset>/models/<variant>.vrm`.
   * Multiple variants let the character change outfits later (the
   * reference config's `hiddenGoals` unlock an outfit change at romance-
   * meter level 3, for example) without reworking the preset shape.
   */
  models: VRMModelVariant[]
  /** Picked on load; used until an outfit switch (not yet implemented). */
  defaultModelId: string
  previewUrl: string
  animations: VRMAnimationEntry[]
  licence: string
  /**
   * ElevenLabs voice id used when this character speaks. Not user-editable
   * in v1 — each character has its own baked-in voice to keep them
   * audibly distinct.
   */
  voiceId: string
  /**
   * Full character persona sent as the top block of the system prompt.
   * Marker-protocol instructions (emotion/delay/gesture) are appended by
   * `buildSystemPrompt` so we deliberately keep them OUT of the persona
   * string — no conflicting "don't write emotions" lines here.
   */
  persona: string
  /**
   * Lines spoken on the FIRST visit for this preset (count = 0 in the
   * character store). One is picked at random. Plain text — no markers,
   * no "Say:" wrapping; synthesized directly through the TTS one-shot.
   */
  starters: string[]
  /**
   * Lines spoken on subsequent visits (count >= 1). Same semantics as
   * `starters`.
   */
  returners: string[]
  defaultCameraOffset?: [number, number, number]
}
