import { streamChat, type ChatMessage } from '../adapters/llm'
import { buildSystemPrompt } from '../prompts/system'
import { createResponseCategorizer } from './response-categorizer'
import { createMarkerParser, parseMarker } from './marker-parser'
import { createStreamingSpeaker } from './speech-pipeline'
import { getExpressionController } from '../vrm/expression-controller'
import { getActiveAnimationController } from '../vrm/animation-controller'

export interface TurnHandle {
  /** Resolves when LLM + TTS + playback all complete. */
  promise: Promise<void>
  /** Cancels LLM fetch, TTS fetches, and current playback. */
  abort: () => void
  /** Read-only view of the assistant reply as it streams (for UI display). */
  onAssistantText?: (delta: string) => void
}

export interface RunTurnOptions {
  /** Full chat history including the user's latest message. */
  messages: ChatMessage[]
  /** Character persona block. Required — pass the active preset's `persona`. */
  persona: string
  /** User-authored per-character override appended below the persona. */
  customInstructions?: string
  /** ElevenLabs voice id for this turn's TTS. Defaults to the server's
   *  fallback voice (Rachel) if omitted. */
  voiceId?: string
  /** Called with each assistant text delta AFTER reasoning tags are stripped
   *  and marker tokens are removed. Intended for UI transcript rendering. */
  onAssistantText?: (delta: string) => void
  /** Called with parsed emotion markers (for debug panels). */
  onEmotion?: (emotion: string, intensity: number) => void
  /** Called with parsed gesture (PLAY) markers. */
  onGesture?: (id: string) => void
  /** Called when the LLM stream finishes (before playback finishes). */
  onStreamEnd?: () => void
}

/**
 * Runs one companion turn end-to-end:
 *   fetch /api/chat  →  LLM text stream
 *     → response categorizer (strips <think>…)
 *       → marker parser (splits literal vs <|…|>)
 *         → speech pipeline (literals)  AND  expression controller + delays (specials)
 *
 * Returns a handle for aborting (barge-in, Stop button).
 */
export function runTurn(options: RunTurnOptions): TurnHandle {
  const ac = new AbortController()

  const speaker = createStreamingSpeaker({ voiceId: options.voiceId })
  const expression = getExpressionController()
  const animation = getActiveAnimationController()

  // Chain the parsers: LLM → categorizer → marker parser → outputs
  const marker = createMarkerParser({
    onLiteral: (text) => {
      // Strip a bare marker that a model sometimes emits as `[ACT:happy]`
      // by accident — it's not valid JSON, don't read it aloud.
      speaker.consume(text)
      options.onAssistantText?.(text)
    },
    onSpecial: async (raw) => {
      const parsed = parseMarker(raw)
      if (!parsed) return
      if (parsed.type === 'act') {
        // Face: ADSR envelope for the expression preset
        expression.trigger(parsed.emotion, parsed.intensity)
        // Body: if the preset has a clip bound to this emotion, it plays in
        // parallel. triggerEmotion returns false for unbound emotions — we
        // just rely on the facial expression in that case.
        animation?.triggerEmotion(parsed.emotion)
        options.onEmotion?.(parsed.emotion, parsed.intensity)
      } else if (parsed.type === 'delay') {
        // Pause the speaker by feeding a soft flush + waiting. For Phase 4
        // we approximate with a setTimeout — the streaming speaker's TTS
        // pipeline keeps ordering, so the pause happens between chunks.
        await new Promise<void>((r) => setTimeout(r, parsed.seconds * 1000))
      } else if (parsed.type === 'play') {
        // Gesture whitelist lives in the animation controller; unknown ids
        // return false and are dropped without crashing.
        const started = animation?.play(parsed.id) ?? false
        if (started) options.onGesture?.(parsed.id)
      }
    },
  })

  const categorizer = createResponseCategorizer({
    onSpeech: (text) => marker.consume(text),
    // onReasoning omitted — drop silently. Non-reasoning Grok shouldn't
    // emit any, but defence-in-depth.
  })

  const promise = (async () => {
    try {
      const systemPrompt = buildSystemPrompt({
        persona: options.persona,
        customInstructions: options.customInstructions,
        gestures: animation?.getGestureIds() ?? [],
        boundEmotions: animation?.getBoundEmotions() ?? [],
      })
      const stream = streamChat({
        messages: options.messages,
        systemPrompt,
        signal: ac.signal,
      })

      for await (const delta of stream) {
        if (ac.signal.aborted) break
        await categorizer.consume(delta)
      }

      // Once aborted we abandon the buffered categorizer/marker tails —
      // flushing them would re-emit literals through `onAssistantText`,
      // and `onStreamEnd` would then push a "completed" assistant reply
      // on top of the `[interrupted]` copy the controller already
      // committed. speaker.abort() in the `finally` tears down TTS.
      if (ac.signal.aborted) return

      await categorizer.flush()
      await marker.flush()
      options.onStreamEnd?.()

      await speaker.end()
    } catch (err) {
      // Aborts are expected from the Stop button / barge-in; bubble up any
      // other failure so the caller can surface it.
      if ((err as { name?: string })?.name === 'AbortError') return
      if (ac.signal.aborted) return
      throw err
    } finally {
      // Safety: ensure in-flight TTS + playback are released even on error.
      speaker.abort()
    }
  })()

  return {
    promise,
    abort: () => {
      ac.abort()
      speaker.abort()
      expression.reset()
      animation?.stop()
    },
  }
}
