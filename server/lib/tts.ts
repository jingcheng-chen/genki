import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

let client: ElevenLabsClient | null = null;

/**
 * Lazily initializes the ElevenLabs client. We don't create it at module
 * load because the server must still boot without ELEVENLABS_API_KEY
 * (the /api/health route reports key presence for debugging).
 */
export function getElevenLabsClient(): ElevenLabsClient {
  if (client) return client;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY not set — put it in .env (server-side only)');
  }
  client = new ElevenLabsClient({ apiKey });
  return client;
}

/**
 * Rachel (21m00Tcm4TlvDq8ikWAM) is ElevenLabs' long-standing demo voice —
 * permanently available to any account and a reasonable neutral starting
 * point. Per-character voice selection lands in Phase 6; until then we use
 * this default and allow override via `ELEVENLABS_VOICE_ID`.
 */
export const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';

export const TTS_MODEL_ID = 'eleven_flash_v2_5';
export const TTS_OUTPUT_FORMAT = 'mp3_44100_128' as const;
