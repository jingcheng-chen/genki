import type {
  CharacterVoiceSettings,
  ElevenLabsVoiceSettings,
  FishAudioVoiceSettings,
  VRMPreset,
} from './types'

/**
 * Build-time provider switch. Defaults to fish-audio (the new path); set
 * `VITE_TTS_PROVIDER=elevenlabs` in `.env` to fall back for A/B comparison.
 *
 * The server reads its own `TTS_PROVIDER` env independently — both should
 * agree. They're separate vars (not a single shared one) because the
 * server's value is sensitive in the same sense the API keys are: it
 * controls which third party we call. A single `VITE_*` would expose the
 * choice (and indirectly the key set) to the browser.
 */
export type TTSProvider = 'fish-audio' | 'elevenlabs'

export function getClientTTSProvider(): TTSProvider {
  const raw = (import.meta.env.VITE_TTS_PROVIDER ?? 'fish-audio').toLowerCase()
  return raw === 'elevenlabs' ? 'elevenlabs' : 'fish-audio'
}

export interface PickedVoice {
  voiceId: string
  voiceSettings?: CharacterVoiceSettings
}

/**
 * Resolve which voice id + settings the active TTS provider should see for
 * this preset. The pipelines treat both opaquely and just forward them to
 * /api/tts; the server interprets them per its own `TTS_PROVIDER` env.
 */
export function pickProviderVoice(preset: VRMPreset): PickedVoice {
  const provider = getClientTTSProvider()
  if (provider === 'fish-audio') {
    return {
      voiceId: preset.fishAudioVoiceId,
      voiceSettings: preset.fishAudioVoiceSettings as
        | FishAudioVoiceSettings
        | undefined,
    }
  }
  return {
    voiceId: preset.voiceId,
    voiceSettings: preset.voiceSettings as ElevenLabsVoiceSettings | undefined,
  }
}
