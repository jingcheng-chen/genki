/**
 * Splits a block of text into TTS-friendly chunks.
 *
 * Strategy (mirrors AIRI's `chunkTTSInput`):
 *  - Hard flush on sentence terminators: . ? ! … 。！？
 *  - "Boost mode" for the first `boostChunks` chunks: lower word cap so the
 *    user hears SOMETHING fast (time-to-first-audio is the #1 feel factor).
 *  - Normal chunks are 8-14 words for natural prosody without ballooning
 *    synthesis latency.
 *  - Trailing text shorter than `minChunkWords` is merged into the previous
 *    chunk instead of going alone (avoids a tiny "uh" tail).
 */

export interface ChunkerOptions {
  /** How many opening chunks to keep aggressively short. @default 2 */
  boostChunks?: number
  /** Max word count during boost mode. @default 6 */
  boostMaxWords?: number
  /** Max word count for normal chunks. @default 14 */
  normalMaxWords?: number
  /** Trailing fragments shorter than this merge into the previous chunk. @default 3 */
  minChunkWords?: number
}

const SENTENCE_TERMINATOR = /[.?!…。！？]\s*$/

export function chunkText(text: string, options: ChunkerOptions = {}): string[] {
  const boostChunks = options.boostChunks ?? 2
  const boostMaxWords = options.boostMaxWords ?? 6
  const normalMaxWords = options.normalMaxWords ?? 14
  const minChunkWords = options.minChunkWords ?? 3

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
