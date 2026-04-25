import { Hono } from 'hono'
import {
  getElevenLabsClient,
  DEFAULT_VOICE_ID,
  TTS_MODEL_ID,
  TTS_OUTPUT_FORMAT,
} from '../lib/tts'
import { fishAudioStream, type FishAudioVoiceSettings } from '../lib/tts-fish'

const tts = new Hono()

// Provider switch is a single env var read by both client (Vite-prefixed
// for browser visibility) and server. Defaults to fish-audio because the
// S2 model is the new path; ElevenLabs is retained for A/B comparison.
type TTSProvider = 'fish-audio' | 'elevenlabs'

function getServerTTSProvider(): TTSProvider {
  const raw = (process.env.VITE_TTS_PROVIDER ?? process.env.TTS_PROVIDER ?? 'fish-audio').toLowerCase()
  return raw === 'elevenlabs' ? 'elevenlabs' : 'fish-audio'
}

interface ElevenLabsVoiceSettingsBody {
  stability?: number
  similarityBoost?: number
  style?: number
  useSpeakerBoost?: boolean
  speed?: number
}

// Whitelist + coerce ElevenLabs voice_settings from untrusted client input.
// The SDK accepts extra fields but we'd rather fail fast on a typo than
// have it silently ignored, so we narrow here and drop anything out of
// range. Returns undefined if nothing usable was provided — the SDK then
// falls back to the voice's stored settings.
function sanitizeElevenLabsVoiceSettings(input: unknown): ElevenLabsVoiceSettingsBody | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Record<string, unknown>
  const out: ElevenLabsVoiceSettingsBody = {}
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

// Whitelist + coerce Fish Audio S2 settings. Fish's parameter ranges are
// documented per https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech.
// Out-of-range values cause 422s upstream so we clamp at the boundary
// rather than letting them propagate.
function sanitizeFishAudioVoiceSettings(input: unknown): FishAudioVoiceSettings | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Record<string, unknown>
  const out: FishAudioVoiceSettings = {}
  const num01 = (v: unknown) =>
    typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined
  const t = num01(raw.temperature)
  if (t !== undefined) out.temperature = t
  const tp = num01(raw.topP)
  if (tp !== undefined) out.topP = tp
  if (typeof raw.speed === 'number' && raw.speed >= 0.5 && raw.speed <= 2.0)
    out.speed = raw.speed
  if (typeof raw.volume === 'number' && raw.volume >= -20 && raw.volume <= 20)
    out.volume = raw.volume
  if (typeof raw.normalizeLoudness === 'boolean')
    out.normalizeLoudness = raw.normalizeLoudness
  return Object.keys(out).length ? out : undefined
}

/**
 * POST /api/tts
 * Body: {
 *   text: string
 *   voiceId?: string
 *   previousText?: string    // ElevenLabs-only: v3-style prosody continuation
 *   nextText?: string        // ElevenLabs-only: ditto, one-shot path only
 *   voiceSettings?: object   // shape depends on provider (server interprets)
 * }
 * Returns: audio stream (audio/mpeg) — chunked, framed as soon as upstream
 * generates frames. The browser still waits for the full response before
 * `decodeAudioData`, but our proxy hop adds no buffer stage.
 *
 * The active provider (fish-audio | elevenlabs) is server-side only; the
 * client picks the matching `voiceId`/`voiceSettings` shape via the same
 * VITE_TTS_PROVIDER env (see src/vrm/presets/voice.ts).
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

  const provider = getServerTTSProvider()

  if (provider === 'fish-audio') {
    if (!process.env.FISH_AUDIO_API_KEY) {
      return c.json(
        { error: 'FISH_AUDIO_API_KEY not configured on the server' },
        503,
      )
    }
    if (!body.voiceId) {
      return c.json({ error: 'Missing "voiceId" (Fish Audio reference id)' }, 400)
    }
    const voiceSettings = sanitizeFishAudioVoiceSettings(body.voiceSettings)

    try {
      const upstream = await fishAudioStream({
        text,
        voiceId: body.voiceId,
        voiceSettings,
      })
      // Forward the chunked binary body directly. Content-Type from upstream
      // is audio/mpeg for our requested mp3 format; we restate it explicitly
      // so the client doesn't depend on header passthrough.
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-store',
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[tts:fish-audio]', msg)
      return c.json({ error: msg }, 502)
    }
  }

  // provider === 'elevenlabs'
  const voiceId = body.voiceId ?? DEFAULT_VOICE_ID
  const voiceSettings = sanitizeElevenLabsVoiceSettings(body.voiceSettings)

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
    console.error('[tts:elevenlabs]', msg)
    return c.json({ error: msg }, 502)
  }
})

export { tts }
