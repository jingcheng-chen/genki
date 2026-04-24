/**
 * Maps our ACT-marker emotion names onto ElevenLabs v3 audio tags.
 *
 * v3's expressiveness is unlocked by in-text bracket tags (`[excited]`,
 * `[whispers]`, `[sighs]`, …) — without them the model synthesises each
 * chunk from a neutral prosodic baseline. The facial expression markers
 * we already parse (`<|ACT:{"emotion":"excitement"}|>`) are a perfect
 * signal: if the face goes to `excitement`, the voice should match.
 *
 * The mapping covers the full `ALLOWED_EMOTION_NAMES` set, not just the
 * six VRM primaries, because the extended vocab (excitement, shyness,
 * frustration, …) carries strictly more information — collapsing it to
 * the primary would flatten the read.
 *
 * Returns `null` for `neutral` and unknown names — callers skip adding a
 * tag rather than inserting a noisy `[neutral]`.
 *
 * Intensity is currently unused: v3 does not document an intensity
 * modifier for bracket tags. Parked for the day it does.
 */

const AUDIO_TAGS: Record<string, string> = {
  // --- Six VRM primaries -------------------------------------------------
  happy: '[happily]',
  sad: '[sadly]',
  angry: '[angrily]',
  surprised: '[surprised]',
  relaxed: '[calmly]',
  // neutral intentionally omitted — no tag, clean synthesis.

  // --- Extended reference-vocab emotions ---------------------------------
  curiosity: '[curiously]',
  shyness: '[shyly]',
  excitement: '[excited]',
  love: '[warmly]',
  stress: '[stressed]',
  frustration: '[frustrated]',
  sadness: '[sadly]',
}

export function emotionAudioTag(
  name: string | null | undefined,
  _intensity?: number,
): string | null {
  if (!name) return null
  return AUDIO_TAGS[name.toLowerCase()] ?? null
}
