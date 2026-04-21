import { getAudioContext } from '../audio/context'

/**
 * Synthesizes `text` via the server's /api/tts proxy and decodes the
 * returned MP3 bytes into an `AudioBuffer` ready for Web Audio playback.
 *
 * Use when:
 * - Feeding a sentence-sized chunk of text through the speech pipeline
 *
 * Expects:
 * - AudioContext already resumed (call `resumeAudioContext()` from a user gesture first)
 *
 * Returns:
 * - AudioBuffer decoded and ready to connect to both destination and the
 *   wlipsync analyzer node
 *
 * Throws:
 * - On non-2xx response (includes server error payload in the message)
 * - On `AbortError` if the caller aborts the request
 */
export async function synthesize(
  text: string,
  options: { voiceId?: string; signal?: AbortSignal } = {},
): Promise<AudioBuffer> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    signal: options.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voiceId: options.voiceId }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`TTS ${res.status}: ${errText.slice(0, 200) || res.statusText}`)
  }

  const bytes = await res.arrayBuffer()
  const ctx = getAudioContext()
  return await ctx.decodeAudioData(bytes)
}
