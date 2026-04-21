import { encodeWavPcm16 } from '../audio/wav-encoder'

export interface TranscribeOptions {
  /** Hint the STT provider with a language code ("en", "zh", …). Omit for
   *  auto-detection — worth giving when we know the character's locale. */
  language?: string
  /** Abort mid-flight when the user cancels or a new utterance preempts. */
  signal?: AbortSignal
}

export interface TranscribeResult {
  text: string
  languageCode: string | null
}

/**
 * Encode a VAD-provided PCM segment and POST it to the Hono `/api/stt`
 * route, which proxies to ElevenLabs Scribe. Returns the raw transcript
 * (whitespace-trimmed). Empty strings are passed through — the caller
 * decides whether to skip the turn.
 */
export async function transcribe(
  samples: Float32Array,
  sampleRate: number,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const blob = encodeWavPcm16(samples, sampleRate)

  const form = new FormData()
  form.append('audio', blob, 'utterance.wav')
  if (options.language) form.append('language', options.language)

  const res = await fetch('/api/stt', {
    method: 'POST',
    body: form,
    signal: options.signal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`[stt] ${res.status} ${res.statusText}: ${body}`)
  }

  const payload = (await res.json()) as {
    text?: string
    languageCode?: string | null
  }

  return {
    text: (payload.text ?? '').trim(),
    languageCode: payload.languageCode ?? null,
  }
}
