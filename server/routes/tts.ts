import { Hono } from 'hono'
import {
  getElevenLabsClient,
  DEFAULT_VOICE_ID,
  TTS_MODEL_ID,
  TTS_OUTPUT_FORMAT,
} from '../lib/tts'

const tts = new Hono()

interface VoiceSettingsBody {
  stability?: number
  similarityBoost?: number
  style?: number
  useSpeakerBoost?: boolean
  speed?: number
}

// Whitelist + coerce voice_settings from untrusted client input. The
// ElevenLabs SDK accepts extra fields but we'd rather fail fast on a typo
// than have it silently ignored, so we narrow here and drop anything out
// of range. Returns undefined if nothing usable was provided — the SDK
// then falls back to the voice's stored settings.
function sanitizeVoiceSettings(input: unknown): VoiceSettingsBody | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Record<string, unknown>
  const out: VoiceSettingsBody = {}
  const num01 = (v: unknown) =>
    typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined
  const s = num01(raw.stability)
  if (s !== undefined) out.stability = s
  const sb = num01(raw.similarityBoost)
  if (sb !== undefined) out.similarityBoost = sb
  const st = num01(raw.style)
  if (st !== undefined) out.style = st
  if (typeof raw.useSpeakerBoost === 'boolean') out.useSpeakerBoost = raw.useSpeakerBoost
  // NOTICE: `speed` is a noisy cross-model situation.
  //   - `eleven_v3` silently IGNORES speed (verified via direct API probe).
  //   - `eleven_flash_v2_5` enforces [0.7, 1.2] and 400s outside.
  //   - `eleven_multilingual_v2` / `turbo_v2_5` accept a wider range.
  // We clamp to the tightest supported range here so an out-of-range value
  // is caught at our boundary instead of surfacing as a generic TTS 502
  // later. Widen if/when we move off v3 and need bigger swings.
  if (typeof raw.speed === 'number' && raw.speed >= 0.7 && raw.speed <= 1.2)
    out.speed = raw.speed
  return Object.keys(out).length ? out : undefined
}

/**
 * POST /api/tts
 * Body: {
 *   text: string
 *   voiceId?: string
 *   previousText?: string    // v3 prosody continuation
 *   nextText?: string        // only set by the one-shot speak() path
 *   voiceSettings?: { stability, similarityBoost, style, useSpeakerBoost, speed }
 * }
 * Returns: audio/mpeg stream
 *
 * Uses the SDK's streaming endpoint so audio frames start flowing from
 * ElevenLabs as soon as they're generated rather than being buffered
 * server-side. (The browser still waits for the full response before
 * `decodeAudioData`, but perceived end-to-end latency improves on longer
 * chunks because our own proxy hop doesn't add a buffer stage.)
 */
tts.post('/', async (c) => {
  let body: {
    text?: string
    voiceId?: string
    previousText?: string
    nextText?: string
    voiceSettings?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const text = body.text?.trim()
  if (!text) return c.json({ error: 'Missing "text"' }, 400)

  const voiceId = body.voiceId ?? DEFAULT_VOICE_ID
  const voiceSettings = sanitizeVoiceSettings(body.voiceSettings)

  // NOTICE:
  // As of 2026-04, ElevenLabs returns HTTP 400 `unsupported_model` when
  // `previous_text` / `next_text` is sent with `eleven_v3`:
  //   "Providing previous_text or next_text is not yet supported with the
  //    'eleven_v3' model."
  // The continuity knobs still work great on `eleven_multilingual_v2` /
  // `eleven_turbo_v2_5` / Flash, so we keep the client plumbing in place
  // and just gate the payload here. Drop this branch when v3 gains support
  // (or when we change models).
  const supportsContinuity = TTS_MODEL_ID !== 'eleven_v3'
  const previousText = supportsContinuity
    ? body.previousText?.slice(-500) || undefined
    : undefined
  const nextText = supportsContinuity
    ? body.nextText?.slice(0, 500) || undefined
    : undefined

  if (!process.env.ELEVENLABS_API_KEY) {
    return c.json(
      { error: 'ELEVENLABS_API_KEY not configured on the server' },
      503,
    )
  }

  try {
    const client = getElevenLabsClient()
    const stream = await client.textToSpeech.stream(voiceId, {
      text,
      modelId: TTS_MODEL_ID,
      outputFormat: TTS_OUTPUT_FORMAT,
      previousText,
      nextText,
      voiceSettings,
    })

    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[tts]', msg)
    return c.json({ error: msg }, 502)
  }
})

export { tts }
