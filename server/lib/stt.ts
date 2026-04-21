import { getElevenLabsClient } from './tts'

/**
 * Scribe speech-to-text. We reuse the same ElevenLabsClient singleton the
 * TTS route uses — one API key, one HTTP agent, one shared rate-limit
 * bucket. The STT surface is just a different resource on the same client.
 */
export { getElevenLabsClient }

/**
 * Scribe v1 is the stable GA transcription model. It accepts dozens of
 * languages; Aria only needs en-US + zh-CN today, but we leave the model
 * choice here so Phase 6+ can swap it per character.
 */
export const STT_MODEL_ID = 'scribe_v1' as const

/**
 * We always send 16-bit signed-LE PCM at 16kHz, mono — that's the VAD's
 * native output rate, and the Scribe `pcm_s16le_16` fast path skips the
 * server-side transcode, trimming ~100-200ms off the transcription
 * round-trip.
 */
export const STT_FILE_FORMAT = 'pcm_s16le_16' as const
