/**
 * Fish Audio S2-Pro client. Plain `fetch` against the public REST endpoint —
 * the official `fish-audio` SDK targets a WebSocket realtime mode that's
 * overkill for our sentence-sized chunked sends, and adds a dependency we
 * don't otherwise need. The endpoint returns a chunked binary audio stream
 * (Transfer-Encoding: chunked), which we surface verbatim to the browser
 * the same way ElevenLabs's stream is surfaced — no buffer stage on our
 * proxy hop.
 *
 * Reference docs: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
 * S2 model overview: https://fish.audio/blog/fish-audio-s2-fine-grained-ai-voice-control-at-the-word-level/
 */

const FISH_API_BASE =
  process.env.FISH_AUDIO_BASE_URL ?? 'https://api.fish.audio'

// `s2-pro` selects the Fish Audio S2 model — open-domain inline tag control
// (e.g. `[whispering] Don't let them hear you.`), word-level prosody, and
// the lowest TTFB on Fish's roster. Set via the `model` HTTP header per
// upstream docs (NOT a body field).
const FISH_MODEL = 's2-pro' as const

const DEFAULT_FORMAT = 'mp3' as const
const DEFAULT_SAMPLE_RATE = 44100
const DEFAULT_MP3_BITRATE = 128

export interface FishAudioVoiceSettings {
  temperature?: number
  topP?: number
  speed?: number
  volume?: number
  normalizeLoudness?: boolean
}

export interface FishAudioTTSParams {
  text: string
  /** Reference id (Fish's model-id concept — voice library entry or cloned reference). */
  voiceId: string
  voiceSettings?: FishAudioVoiceSettings
  signal?: AbortSignal
}

interface FishAudioRequestBody {
  text: string
  reference_id: string
  format: typeof DEFAULT_FORMAT
  sample_rate: number
  mp3_bitrate: number
  // `low` cuts ~50ms off TTFB at a small quality cost; `normal` is the
  // safer default since first-byte from Fish is already ~100ms on S2.
  latency: 'low' | 'normal' | 'balanced'
  // Hold within [100, 300]. Smaller chunks = lower TTFB, more boundaries
  // (we already chunk per-sentence ourselves so the upstream rarely splits).
  chunk_length: number
  temperature?: number
  top_p?: number
  prosody?: {
    speed?: number
    volume?: number
    normalize_loudness?: boolean
  }
}

/**
 * Issue a Fish Audio TTS request. Returns the raw upstream Response so the
 * Hono handler can pipe its body straight to the browser without buffering.
 *
 * Throws iff the upstream returned non-2xx — caller decides what to do
 * with the message (typically: surface as 502 with the body excerpt).
 */
export async function fishAudioStream(
  params: FishAudioTTSParams,
): Promise<Response> {
  const apiKey = process.env.FISH_AUDIO_API_KEY
  if (!apiKey) {
    throw new Error('FISH_AUDIO_API_KEY not set — put it in .env (server-side only)')
  }

  const body: FishAudioRequestBody = {
    text: params.text,
    reference_id: params.voiceId,
    format: DEFAULT_FORMAT,
    sample_rate: DEFAULT_SAMPLE_RATE,
    mp3_bitrate: DEFAULT_MP3_BITRATE,
    latency: 'normal',
    chunk_length: 200,
  }

  const vs = params.voiceSettings
  if (vs) {
    if (typeof vs.temperature === 'number') body.temperature = vs.temperature
    if (typeof vs.topP === 'number') body.top_p = vs.topP
    const prosody: FishAudioRequestBody['prosody'] = {}
    if (typeof vs.speed === 'number') prosody.speed = vs.speed
    if (typeof vs.volume === 'number') prosody.volume = vs.volume
    if (typeof vs.normalizeLoudness === 'boolean') prosody.normalize_loudness = vs.normalizeLoudness
    if (Object.keys(prosody).length > 0) body.prosody = prosody
  }

  const res = await fetch(`${FISH_API_BASE}/v1/tts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // NOTICE: Fish Audio model selection is a header, not a body field.
      // The body's `reference_id` is the *voice*; the header's `model` is
      // the *backend* (s2-pro vs s1). Sending model in the body silently
      // gets ignored and you'll fall back to s1's default.
      'model': FISH_MODEL,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Fish Audio ${res.status}: ${errText.slice(0, 300) || res.statusText}`)
  }

  return res
}
