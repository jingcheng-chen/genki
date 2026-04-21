/**
 * Streaming reasoning-tag stripper.
 *
 * Defense-in-depth: our default model is Grok non-reasoning, which shouldn't
 * emit these. But swapping to a reasoning variant (o1, DeepSeek R1, extended
 * thinking Claude) must not leak chain-of-thought into TTS — we'd read the
 * model's private monologue aloud before the answer.
 *
 * Strategy:
 *   - While inside a known <think>/<thinking>/<reasoning>/<thought> tag,
 *     route chunks to `onReasoning` (defaults to a no-op: silently drop).
 *   - Outside those tags, route chunks to `onSpeech`.
 *   - Buffer a small tail so an opening tag split across deltas (e.g.
 *     "<thin" + "king>") is detected correctly.
 */

const REASONING_TAGS = ['think', 'thinking', 'reasoning', 'thought']

// Longest possible opening-tag prefix we might need to hold back while
// deciding whether it's a tag. 12 = length of '<reasoning' (10) + a bit of
// slack so we don't thrash on near-matches.
const TAIL_HOLD = 12

export interface ResponseCategorizerOptions {
  onSpeech: (text: string) => void | Promise<void>
  /** Called with content inside reasoning tags. Defaults to drop. */
  onReasoning?: (text: string, tagName: string) => void | Promise<void>
}

type State =
  | { kind: 'outside' }
  | { kind: 'inside'; tagName: string }

export function createResponseCategorizer(options: ResponseCategorizerOptions) {
  const onReasoning = options.onReasoning ?? (() => {})

  let state: State = { kind: 'outside' }
  let buffer = ''

  const openingRe = new RegExp(`<(${REASONING_TAGS.join('|')})>`, 'i')

  async function pump() {
    // Process as much of `buffer` as we can decide about.
    // Returns true if we made progress, false if we need more input.
    while (true) {
      if (state.kind === 'outside') {
        const m = openingRe.exec(buffer)
        if (!m) {
          // No tag seen. Emit everything except the last TAIL_HOLD chars
          // in case a tag is spanning the chunk boundary.
          if (buffer.length <= TAIL_HOLD) return
          const emit = buffer.slice(0, -TAIL_HOLD)
          buffer = buffer.slice(-TAIL_HOLD)
          await options.onSpeech(emit)
          return
        }
        // Everything before the tag is speech.
        if (m.index > 0) {
          await options.onSpeech(buffer.slice(0, m.index))
        }
        const tagName = m[1].toLowerCase()
        state = { kind: 'inside', tagName }
        buffer = buffer.slice(m.index + m[0].length)
        // Fallthrough to process remaining buffer inside the tag.
      } else {
        const closeTag = `</${state.tagName}>`
        const idx = buffer.toLowerCase().indexOf(closeTag.toLowerCase())
        if (idx < 0) {
          // Not yet closed. Emit what we have as reasoning and hold a tail
          // in case '</think' spans a chunk boundary.
          const keepTail = closeTag.length
          if (buffer.length <= keepTail) return
          const emit = buffer.slice(0, -keepTail)
          buffer = buffer.slice(-keepTail)
          await onReasoning(emit, state.tagName)
          return
        }
        if (idx > 0) {
          await onReasoning(buffer.slice(0, idx), state.tagName)
        }
        buffer = buffer.slice(idx + closeTag.length)
        state = { kind: 'outside' }
      }
    }
  }

  return {
    async consume(delta: string) {
      if (!delta) return
      buffer += delta
      await pump()
    },
    async flush() {
      // Emit whatever is left: if we're mid-tag, it's truncated reasoning
      // (drop). Otherwise it's trailing speech.
      if (state.kind === 'outside' && buffer.length > 0) {
        await options.onSpeech(buffer)
      } else if (state.kind === 'inside' && buffer.length > 0) {
        await onReasoning(buffer, state.tagName)
      }
      buffer = ''
      state = { kind: 'outside' }
    },
  }
}
