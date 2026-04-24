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

// ---------------------------------------------------------------------------
// Inline audio tags (LLM-emitted, not derived from ACT markers)
// ---------------------------------------------------------------------------
//
// Alongside the ACT-driven tag injection above, we let the LLM sprinkle a
// small vocabulary of delivery cues directly inline in its reply text. These
// are orthogonal to emotion — they describe prosody / pacing / breath and
// stack with any ACT-derived tag on the same chunk. Example:
//
//   "[happily] That's [laughs] amazing."
//
// v3 reads both, the face still fires from the ACT marker, and the voice
// layers the giggle mid-sentence. Position matters: `[laughs]` at the start
// means "start laughing now"; mid-sentence means "insert here".
//
// The whitelist stays deliberately small and non-overlapping with the
// ACT-derived emotional tags. Keep it to delivery cues, not feelings —
// feelings belong in `<|ACT:…|>` so the face stays in sync.

export const INLINE_AUDIO_TAGS = [
  'sighs',
  'laughs',
  'laughs softly',
  'whispers',
  'quickly',
  'slowly',
  'thoughtfully',
  'softly',
  'breathes',
] as const

// Matches a whitelisted bracketed tag and consumes exactly ONE adjacent
// space — either the preceding or trailing one, whichever exists. This
// keeps "hello [softly] world" → "hello world" (single space preserved)
// while also handling end-of-string cases like ". [sighs]" → "." without
// leaving a dangling trailing space. `g` + `i` catch every occurrence
// regardless of case.
const TAG_INNER =
  'sighs|laughs(?:\\s+softly)?|whispers|quickly|slowly|thoughtfully|softly|breathes'
const INLINE_AUDIO_TAG_REGEX = new RegExp(
  // eslint-disable-next-line no-useless-concat
  ` \\[(?:${TAG_INNER})\\]` + '|' + `\\[(?:${TAG_INNER})\\] ?`,
  'gi',
)

/**
 * Strip inline audio tags from text destined for the transcript / memory
 * extractor. TTS keeps the tags (v3 reads them); only human-facing text
 * gets them removed.
 */
export function stripInlineAudioTags(text: string): string {
  return text.replace(INLINE_AUDIO_TAG_REGEX, '')
}

/**
 * Streaming-safe stripper. LLM deltas can split a tag across chunks
 * ("Oh man, [laughs softl" → "y] I wi"), so a per-delta strip would miss
 * the seam. This wrapper holds back any unclosed `[` suffix until its
 * closing `]` arrives, then runs `stripInlineAudioTags` on the safe
 * prefix. Same pattern as the marker parser's TAIL_HOLD but keyed on
 * bracket state, not a fixed character count.
 *
 * Callers must invoke `flush()` at end-of-stream to drain any still-
 * unclosed tail. An unclosed `[…` with no closing bracket is emitted
 * as-is — the LLM gave us a broken tag, we preserve it rather than
 * silently dropping it.
 */
export function createInlineAudioTagStripper(): {
  push: (text: string) => string
  flush: () => string
} {
  let hold = ''
  return {
    push(text: string): string {
      const combined = hold + text
      const lastOpen = combined.lastIndexOf('[')
      const closedAfterOpen =
        lastOpen !== -1 && combined.indexOf(']', lastOpen) !== -1
      if (lastOpen === -1 || closedAfterOpen) {
        hold = ''
        return stripInlineAudioTags(combined)
      }
      hold = combined.slice(lastOpen)
      return stripInlineAudioTags(combined.slice(0, lastOpen))
    },
    flush(): string {
      const out = stripInlineAudioTags(hold)
      hold = ''
      return out
    },
  }
}
