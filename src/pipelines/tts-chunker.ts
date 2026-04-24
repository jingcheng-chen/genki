/**
 * Splits a block of text into TTS-friendly chunks.
 *
 * Strategy:
 *  - Hard flush on sentence terminators: . ? ! … 。！？ — the common case.
 *  - "Boost mode" for the first `boostChunks` chunks: lower word cap so the
 *    user hears SOMETHING fast (time-to-first-audio is the #1 feel factor).
 *  - Normal chunks have a deliberately generous cap — ElevenLabs v3 needs a
 *    meaningful span of text to plan prosody (breath, pitch contour,
 *    emotional envelope). Too-small chunks produce the audible "stateless
 *    neutral reset" at every boundary. The cap is a safety net; in practice
 *    sentence terminators flush long before we hit it.
 *  - Trailing text shorter than `minChunkWords` is merged into the previous
 *    chunk instead of going alone (avoids a tiny "uh" tail).
 */

export interface ChunkerOptions {
  /** How many opening chunks to keep aggressively short. @default 1 */
  boostChunks?: number
  /** Max word count during boost mode. @default 18 */
  boostMaxWords?: number
  /** Soft max word count for normal chunks (sentence terminators flush first). @default 45 */
  normalMaxWords?: number
  /** Trailing fragments shorter than this merge into the previous chunk. @default 5 */
  minChunkWords?: number
}

const SENTENCE_TERMINATOR = /[.?!…。！？]\s*$/

export function chunkText(text: string, options: ChunkerOptions = {}): string[] {
  const boostChunks = options.boostChunks ?? 1
  const boostMaxWords = options.boostMaxWords ?? 18
  const normalMaxWords = options.normalMaxWords ?? 45
  const minChunkWords = options.minChunkWords ?? 5

  const chunks: string[] = []
  let buffer = ''

  const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

  const flush = () => {
    const trimmed = buffer.trim()
    if (trimmed) chunks.push(trimmed)
    buffer = ''
  }

  // Split preserving whitespace so we don't destroy spacing on rejoin.
  const tokens = text.split(/(\s+)/).filter((t) => t.length > 0)

  for (const token of tokens) {
    buffer += token
    const words = wordCount(buffer)
    const maxWords = chunks.length < boostChunks ? boostMaxWords : normalMaxWords
    const endsSentence = SENTENCE_TERMINATOR.test(buffer)

    if (endsSentence || words >= maxWords) flush()
  }
  flush()

  // Merge tiny trailing fragments into the previous chunk.
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1]
    if (wordCount(last) < minChunkWords) {
      chunks[chunks.length - 2] = `${chunks[chunks.length - 2]} ${last}`.trim()
      chunks.pop()
    }
  }

  return chunks
}
