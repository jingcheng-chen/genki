import { getAudioContext } from '../audio/context'
import type { CharacterVoiceSettings } from '../vrm/presets/types'

export interface SynthesizeOptions {
  voiceId?: string
  signal?: AbortSignal
  /**
   * Spoken text that came *before* `text` in this reply. Used as v3's
   * `previous_text` so the model plans prosody continuing from it rather
   * than resetting to neutral at every chunk boundary.
   */
  previousText?: string
  /**
   * Spoken text that comes *after* `text` in this reply. Only available in
   * the one-shot path where we know the full reply up front; the streaming
   * speaker leaves this empty because it flushes chunks as soon as they
   * complete.
   */
  nextText?: string
  /** Per-character voice_settings override. */
  voiceSettings?: CharacterVoiceSettings
}

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
  options: SynthesizeOptions = {},
): Promise<AudioBuffer> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    signal: options.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voiceId: options.voiceId,
      previousText: options.previousText,
      nextText: options.nextText,
      voiceSettings: options.voiceSettings,
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`TTS ${res.status}: ${errText.slice(0, 200) || res.statusText}`)
  }

  const bytes = await res.arrayBuffer()
  const ctx = getAudioContext()
  return await ctx.decodeAudioData(bytes)
}
