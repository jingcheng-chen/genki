import { streamChat, type ChatMessage } from '../adapters/llm'
import { buildSystemPrompt } from '../prompts/system'
import { createResponseCategorizer } from './response-categorizer'
import { createMarkerParser, parseMarker } from './marker-parser'
import { createStreamingSpeaker } from './speech-pipeline'
import { getExpressionController } from '../vrm/expression-controller'
import { getActiveAnimationController } from '../vrm/animation-controller'
import { resolveEmotion } from '../vrm/emotion-vocab'
import { tracer } from '../observability/tracer'

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
  /** Pre-rendered memory block from the retriever. Empty string = first
   *  turn / no memory yet — the system prompt omits the section. */
  memoryBlock?: string
  /** IDs of the facts surfaced in `memoryBlock`. Opaque to `runTurn`; the
   *  caller forwards them to the extractor so it can reason about which
   *  facts were "in context" this turn. */
  retrievedFactIds?: string[]
  /** ElevenLabs voice id for this turn's TTS. Defaults to the server's
   *  fallback voice (Rachel) if omitted. */
  voiceId?: string
  /** Opaque id the controller assigned this turn. Threaded through every
   *  tracer event so the Turns tab can group them. */
  turnId?: string
  /** Wall-clock ms when the turn started (Date.now from turn-controller).
   *  Used to compute `llm.first-token` / `turn.first-audio` offsets. */
  turnStartTs?: number
  /** Called with each assistant text delta AFTER reasoning tags are stripped
   *  and marker tokens are removed. Intended for UI transcript rendering. */
  onAssistantText?: (delta: string) => void
  /** Called with parsed emotion markers (for debug panels). */
  onEmotion?: (emotion: string, intensity: number) => void
  /** Called with parsed gesture (PLAY) markers. */
  onGesture?: (id: string) => void
  /** Called when the LLM stream finishes (before playback finishes). */
  onStreamEnd?: () => void
  /** Called after the stream ends with the full-turn payload the extractor
   *  needs. Fire-and-forget — never awaited from inside `runTurn`. */
  onTurnComplete?: (result: {
    userTurn: string
    assistantTurn: string
    retrievedFactIds: string[]
  }) => void
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
  const turnId = options.turnId ?? null
  const turnStartTs = options.turnStartTs ?? Date.now()

  const speaker = createStreamingSpeaker({
    voiceId: options.voiceId,
    turnId,
    turnStartTs,
  })
  const expression = getExpressionController()
  const animation = getActiveAnimationController()

  // Collect the post-marker-strip assistant text for the extractor.
  // This is the "clean" text the TTS received, which is what the
  // memory curator should reason over — marker tokens would pollute
  // the extraction.
  let assistantAccum = ''
  let firstTokenSeen = false

  // Chain the parsers: LLM → categorizer → marker parser → outputs
  const marker = createMarkerParser({
    onLiteral: (text) => {
      tracer.emit({ category: 'marker.literal', data: { text }, turnId })
      // Strip a bare marker that a model sometimes emits as `[ACT:happy]`
      // by accident — it's not valid JSON, don't read it aloud.
      speaker.consume(text)
      assistantAccum += text
      options.onAssistantText?.(text)
    },
    onSpecial: async (raw) => {
      const parsed = parseMarker(raw)
      tracer.emit({
        category: 'marker.special',
        data: { raw, parsed },
        turnId,
      })
      if (!parsed) return
      if (parsed.type === 'act') {
        // Face: ADSR envelope for the expression preset. The controller
        // resolves aliases + recipes internally, so we pass the raw name.
        expression.trigger(parsed.emotion, parsed.intensity)
        // Body: `VRMAnimationEntry.emotion` bindings are keyed to the six
        // VRM primaries (happy/sad/angry/surprised/relaxed/neutral), so we
        // canonicalize the raw name to its dominant primary before the
        // lookup. `excitement` → `happy` → the `blush` clip fires, even
        // though the face is a multi-channel happy+surprised blend.
        // Falls through to the raw name if the resolver doesn't know it —
        // a preset could still bind a body clip to a custom emotion name.
        const resolved = resolveEmotion(parsed.emotion)
        const animKey = resolved?.primary ?? parsed.emotion
        const bound = animation?.triggerEmotion(animKey) ?? false
        tracer.emit({
          category: 'anim.emotion',
          data: {
            emotion: parsed.emotion,
            resolvedPrimary: resolved?.primary ?? null,
            intensity: parsed.intensity,
            bound,
          },
          turnId,
        })
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
        tracer.emit({
          category: 'anim.gesture',
          data: { id: parsed.id, started },
          turnId,
        })
        if (started) options.onGesture?.(parsed.id)
      }
    },
  })

  const categorizer = createResponseCategorizer({
    onSpeech: (text) => {
      tracer.emit({ category: 'categorizer.speech', data: { text }, turnId })
      return marker.consume(text)
    },
    onReasoning: (text, tagName) => {
      tracer.emit({
        category: 'categorizer.reason',
        data: { text, tagName },
        turnId,
      })
    },
  })

  const promise = (async () => {
    try {
      const systemPrompt = buildSystemPrompt({
        persona: options.persona,
        customInstructions: options.customInstructions,
        memoryBlock: options.memoryBlock,
        gestures: animation?.getGestureIds() ?? [],
        boundEmotions: animation?.getBoundEmotions() ?? [],
      })
      tracer.emit({
        category: 'llm.request',
        data: {
          systemPromptLen: systemPrompt.length,
          messages: options.messages.map((m) => ({
            role: m.role,
            contentLen: m.content.length,
          })),
          voiceId: options.voiceId,
        },
        turnId,
      })
      const stream = streamChat({
        messages: options.messages,
        systemPrompt,
        signal: ac.signal,
        turnId,
        turnStartTs,
      })

      const streamStartTs = Date.now()
      for await (const delta of stream) {
        if (ac.signal.aborted) break
        if (!firstTokenSeen) {
          firstTokenSeen = true
          tracer.emit({
            category: 'llm.first-token',
            data: { ms: Date.now() - turnStartTs },
            turnId,
          })
        }
        tracer.emit({ category: 'llm.raw-delta', data: { delta }, turnId })
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
      tracer.emit({
        category: 'llm.stream-end',
        data: {
          assistantText: assistantAccum,
          // Rough estimate: 4 chars per token is the mean across English.
          estimatedTokens: Math.round(assistantAccum.length / 4),
          durationMs: Date.now() - streamStartTs,
        },
        turnId,
      })
      options.onStreamEnd?.()

      // Fire the extractor hook BEFORE awaiting final playback. The user
      // controller uses it to enqueue background memory work, which
      // should race playback rather than wait on it.
      if (options.onTurnComplete) {
        const lastUser = [...options.messages]
          .reverse()
          .find((m) => m.role === 'user')
        options.onTurnComplete({
          userTurn: lastUser?.content ?? '',
          assistantTurn: assistantAccum,
          retrievedFactIds: options.retrievedFactIds ?? [],
        })
      }

      await speaker.end()
    } catch (err) {
      // Aborts are expected from the Stop button / barge-in; bubble up any
      // other failure so the caller can surface it.
      if ((err as { name?: string })?.name === 'AbortError') return
      if (ac.signal.aborted) return
      tracer.emit({
        category: 'llm.error',
        data: {
          message: err instanceof Error ? err.message : String(err),
          stage: 'stream',
        },
        turnId,
      })
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
