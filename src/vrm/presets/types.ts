/**
 * Shared types for VRM character presets.
 *
 * Separated from `index.ts` so per-character files can depend on the
 * shapes without pulling in the full preset registry (and vice versa).
 */

import type { EmotionName } from '../emotion-vocab'

/**
 * Languages the companion explicitly supports. The greeting pipeline,
 * fallback roster, and language-sniff heuristic all key off this union.
 * Adding a language means a new code AND new greeting lines per preset.
 */
export type Lang = 'en-US' | 'zh-CN'

/**
 * ElevenLabs v3 voice_settings override for a character. Any omitted field
 * falls back to the server default (which in turn falls back to the model's
 * stored voice settings). See ElevenLabs docs for meaning; in short:
 *   - stability:        lower = more emotional range, higher = flatter
 *   - similarityBoost:  how tightly to hold the original voice identity
 *   - style:            exaggerate the speaker's style (0 = none)
 *   - useSpeakerBoost:  small quality/similarity bump at a latency cost
 *   - speed:            1.0 = default; <1 slower, >1 faster
 */
export interface ElevenLabsVoiceSettings {
  stability?: number
  similarityBoost?: number
  style?: number
  useSpeakerBoost?: boolean
  speed?: number
}

/**
 * Fish Audio S2-Pro tuning knobs. Different idiom from ElevenLabs: the
 * sampler temperature/top_p control variation; prosody is a nested block
 * because that's how the upstream API shapes it.
 *   - temperature:       0–1, default 0.7. Higher = more variation.
 *   - topP:              0–1, default 0.7. Nucleus sampling.
 *   - speed:             0.5–2.0 multiplier on speaking rate.
 *   - volume:            decibel adjustment. 0 = passthrough.
 *   - normalizeLoudness: S2-Pro only. Smooths volume across chunks.
 */
export interface FishAudioVoiceSettings {
  temperature?: number
  topP?: number
  speed?: number
  volume?: number
  normalizeLoudness?: boolean
}

/**
 * Provider-tagged voice settings. We keep the legacy name so the dozens of
 * pipeline call sites that already type `voiceSettings: CharacterVoiceSettings`
 * keep working. The fields don't overlap, so a single object is unambiguously
 * one provider's shape — call sites just forward it through to /api/tts and
 * let the server interpret.
 */
export type CharacterVoiceSettings = ElevenLabsVoiceSettings | FishAudioVoiceSettings

/**
 * A single outfit variant of a character's VRM model. A preset ships one or
 * more variants; `defaultModelId` picks which one loads by default.
 *
 * Two ways the active variant gets switched at runtime:
 *   1. The CharacterPicker outfit row — thumbnails read `previewUrl`.
 *   2. An LLM-emitted `<|OUTFIT:<id>|>` marker. The model is told the
 *      available ids + `description` for each so it can map "change into
 *      something cozy" to the right variant.
 *
 * Convention: the `.png|.jpg` next to each `.vrm` in
 * `/public/vrm/<preset>/models/` is the thumbnail for that variant.
 */
export interface VRMModelVariant {
  /** Stable id — e.g. 'default', 'casual', 'school_uniform'. */
  id: string
  /** Display name for the outfit-swap UI. */
  label: string
  /** Public-served VRM url, e.g. '/vrm/shiro/models/shiro_casual.vrm'. */
  url: string
  /** Public-served thumbnail url, e.g. '/vrm/shiro/models/shiro_casual.png'. */
  previewUrl: string
  /**
   * Short LLM-facing hint describing the outfit. Injected into the system
   * prompt's outfit block so the model can match a casual user request
   * ("get into something more comfy") to the right variant id.
   * Keep it terse — a few descriptive words, no marketing copy.
   * Optional: when missing the model still sees `id` and `label`.
   */
  description?: string
}

/**
 * One animation clip in a preset's library.
 *
 *  - 'idle'         — exactly one per preset; the "default" idle clip.
 *                     If no `idle_variant` clips are declared, it loops
 *                     forever as the base layer (legacy behaviour). If
 *                     variants are declared, it joins them in a random
 *                     chain — each clip plays once and the controller
 *                     picks the next one on `finished`.
 *  - 'idle_variant' — extra idle clips that participate in the random
 *                     idle chain alongside the default. Invisible to the
 *                     LLM. Zero or more per preset.
 *  - 'emotion'      — paired with an `<|ACT:{"emotion":…}|>` marker from
 *                     the LLM; plays for `holdSeconds` (default 3s) then
 *                     fades back to the current base. `emotion` must be
 *                     one of the 6 VRM primaries.
 *  - 'gesture'      — triggered by `<|PLAY:id|>`; plays once then fades
 *                     back to the current base.
 *  - 'talking'      — speaking-idle variants. Invisible to the LLM. The
 *                     animation controller randomly picks one while the
 *                     turn controller is in the 'speaking' state and
 *                     chains the next variant whenever the current clip
 *                     finishes, until speaking ends. A preset with zero
 *                     'talking' clips simply stays on the regular idle
 *                     during speech.
 */
export interface VRMAnimationEntry {
  id: string
  url: string
  kind: 'idle' | 'idle_variant' | 'emotion' | 'gesture' | 'talking'
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
   * audibly distinct. Used when `TTS_PROVIDER=elevenlabs`.
   */
  voiceId: string
  /**
   * Per-character ElevenLabs voice_settings override. Tunes stability /
   * style / speaker-boost to the character's personality. Omit to use
   * server defaults.
   */
  voiceSettings?: ElevenLabsVoiceSettings
  /**
   * Fish Audio S2-Pro reference id (their model-id concept; from the
   * voice library or a cloned reference). Used when `TTS_PROVIDER=fish-audio`.
   */
  fishAudioVoiceId: string
  /**
   * Per-character Fish Audio S2 tuning. Different shape from ElevenLabs's
   * stability/style — Fish exposes sampler temperature plus a prosody
   * block. Omit to use server defaults.
   */
  fishAudioVoiceSettings?: FishAudioVoiceSettings
  /**
   * Full character persona sent as the top block of the system prompt.
   * Marker-protocol instructions (emotion/delay/gesture) are appended by
   * `buildSystemPrompt` so we deliberately keep them OUT of the persona
   * string — no conflicting "don't write emotions" lines here.
   */
  persona: string
  /**
   * The language the character defaults to when we have no other signal
   * (no persisted lastUserLang, no matching navigator.language). The
   * greeting pipeline and the persona's "default to X" line both key off
   * this.
   */
  defaultLanguage: Lang
  /**
   * Static fallback roster for the FIRST visit (greetedPresets count = 0).
   * Keyed by language — one is picked at random from the matching pool.
   * Used when the LLM-generated greeting errors out or times out. Plain
   * text — no markers, no "Say:" wrapping; synthesized directly through
   * the TTS one-shot.
   */
  starters: Record<Lang, string[]>
  /**
   * Static fallback roster for subsequent visits (count >= 1). Same
   * per-language shape as `starters`.
   */
  returners: Record<Lang, string[]>
  defaultCameraOffset?: [number, number, number]
}
