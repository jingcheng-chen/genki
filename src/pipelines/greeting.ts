import { streamChat } from '../adapters/llm'
import { speak, createStreamingSpeaker } from './speech-pipeline'
import { createResponseCategorizer } from './response-categorizer'
import { createMarkerParser, parseMarker } from './marker-parser'
import {
  createInlineAudioTagStripper,
  emotionAudioTag,
} from './emotion-audio-tags'
import { buildSystemPrompt } from '../prompts/system'
import { getExpressionController } from '../vrm/expression-controller'
import { getActiveAnimationController } from '../vrm/animation-controller'
import { resolveEmotion } from '../vrm/emotion-vocab'
import { tracer } from '../observability/tracer'
import type { Lang, VRMPreset } from '../vrm/presets'
import type { CharacterVoiceSettings } from '../vrm/presets/types'

/**
 * LLM-generated greeting pipeline.
 *
 * Runs the normal turn pipeline (LLM → categorizer → marker-parser →
 * streaming speaker) but with:
 *   - an EMPTY messages array — the user has not spoken yet,
 *   - a system prompt that includes a `## Session context` block telling
 *     the model it's a first visit / return visit and which language to
 *     open in,
 *   - a 5s hard timeout on the first token; if it doesn't arrive the
 *     pipeline aborts and synthesizes a static fallback line via the
 *     one-shot `speak()` path instead.
 *
 * Callers (turn-controller at session open) are expected to:
 *   1. trigger a "noticing" gesture (peek / look_around) BEFORE awaiting
 *      `runGreeting` — that masks the ~1.3s first-audio gap,
 *   2. show a subtle typing indicator while the promise is pending,
 *   3. push the final assistant text into their history on `onStreamEnd`.
 *
 * Abort semantics mirror `runTurn`: once `signal.aborted` is true we skip
 * categorizer/marker flush AND `onStreamEnd` so a half-buffered tail never
 * rebuilds the live preview after the controller reset it.
 */

const FIRST_TOKEN_TIMEOUT_MS = 5000

export interface GreetingOptions {
  kind: 'starter' | 'returner'
  lang: Lang
  /** Visit count BEFORE this greeting (0 for starters, >=1 for returners). */
  visitCount: number
  preset: VRMPreset
  customInstructions?: string
  memoryBlock?: string
  voiceId?: string
  voiceSettings?: CharacterVoiceSettings
  /** Called with each stripped literal delta for transcript rendering. */
  onAssistantText?: (delta: string) => void
  onEmotion?: (emotion: string, intensity: number) => void
  onGesture?: (id: string) => void
  /** Fires when the LLM stream ends cleanly (before playback finishes).
   *  Not called on the fallback path — a fallback line has no markers and
   *  is pushed to history directly by the caller after `runGreeting` resolves. */
  onStreamEnd?: (fullText: string) => void
  /** Fires only when we've switched to the static-fallback roster. */
  onFallbackText?: (fullText: string) => void
}

export interface GreetingHandle {
  /** Resolves when LLM + TTS + playback all complete (including fallback). */
  promise: Promise<void>
  /** Cancels LLM fetch, TTS fetches, and current playback. */
  abort: () => void
}

/**
 * Builds the per-language kickoff "user" message that triggers the greeting.
 * Authored in the target language so the model's language-mirror rule
 * produces a reply in that language without fighting the system prompt.
 */
function buildKickoff(
  kind: 'starter' | 'returner',
  lang: Lang,
  visitCount: number,
): string {
  if (lang === 'zh-CN') {
    const visitPhrase =
      kind === 'starter'
        ? '这是他/她第一次来访。'
        : `这是他/她第 ${visitCount + 1} 次来找你。`
    return (
      `[会话开始] 用户刚刚到达。${visitPhrase}` +
      `请用普通话自然地打个招呼，简短一句即可。` +
      `可以使用标记（例如 <|ACT:{"emotion":"happy","intensity":0.7}|>）。`
    )
  }
  const visitPhrase =
    kind === 'starter'
      ? 'This is their first visit.'
      : `This is their return (visit count ${visitCount}).`
  return (
    `[Session start] The user just arrived. ${visitPhrase} ` +
    `Greet them naturally in English. One short line. ` +
    `A marker is fine (e.g. <|ACT:{"emotion":"happy","intensity":0.7}|>).`
  )
}

/**
 * Pick a fallback line from the preset's static roster. Falls through to
 * the preset's default-language pool if the requested language has no
 * entries (shouldn't happen, but belt-and-braces — an empty array would
 * otherwise feed `undefined` to the TTS and crash).
 */
function pickFallback(
  preset: VRMPreset,
  kind: 'starter' | 'returner',
  lang: Lang,
): string | null {
  const roster = kind === 'starter' ? preset.starters : preset.returners
  const pool =
    roster[lang]?.length ? roster[lang] : roster[preset.defaultLanguage]
  if (!pool || pool.length === 0) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

export function runGreeting(options: GreetingOptions): GreetingHandle {
  const ac = new AbortController()
  const {
    kind,
    lang,
    visitCount,
    preset,
    customInstructions,
    memoryBlock,
    voiceId,
    voiceSettings,
    onAssistantText,
    onEmotion,
    onGesture,
    onStreamEnd,
    onFallbackText,
  } = options

  const startTs = Date.now()
  const turnId = `g_${Date.now().toString(36)}_${Math.floor(
    Math.random() * 0xffff,
  )
    .toString(16)
    .padStart(4, '0')}`

  tracer.emit({
    category: 'greeting.start',
    data: { kind, lang, visitCount, characterId: preset.id },
    turnId,
  })

  // Playback pipeline (mirrors runTurn).
  const speaker = createStreamingSpeaker({
    voiceId,
    voiceSettings,
    turnId,
    turnStartTs: startTs,
  })
  const expression = getExpressionController()
  const animation = getActiveAnimationController()

  let assistantAccum = ''
  let firstTokenSeen = false
  let firstAudioSeen = false
  const audioTagStripper = createInlineAudioTagStripper()

  const marker = createMarkerParser({
    onLiteral: (text) => {
      speaker.consume(text)
      // First chunk going to TTS — a reasonable proxy for "first audio
      // is imminent". The streaming speaker emits its own
      // `turn.first-audio` on actual playback start with the same turnId,
      // but this gives the Metrics tab an early boundary that isolates
      // the categorizer/marker latency from the TTS round-trip.
      noteFirstAudio()
      const visible = audioTagStripper.push(text)
      if (visible) {
        assistantAccum += visible
        onAssistantText?.(visible)
      }
    },
    onSpecial: async (raw) => {
      const parsed = parseMarker(raw)
      if (!parsed) return
      if (parsed.type === 'act') {
        const tag = emotionAudioTag(parsed.emotion, parsed.intensity)
        if (tag) speaker.setPendingAudioTag(tag)
        expression.trigger(parsed.emotion, parsed.intensity)
        const resolved = resolveEmotion(parsed.emotion)
        const animKey = resolved?.primary ?? parsed.emotion
        animation?.triggerEmotion(animKey)
        onEmotion?.(parsed.emotion, parsed.intensity)
      } else if (parsed.type === 'delay') {
        await new Promise<void>((r) => setTimeout(r, parsed.seconds * 1000))
      } else if (parsed.type === 'play') {
        const started = animation?.play(parsed.id) ?? false
        if (started) onGesture?.(parsed.id)
      }
    },
  })

  const categorizer = createResponseCategorizer({
    onSpeech: (text) => marker.consume(text),
  })

  // Greeting-scoped first-literal marker. Fires once, the first time the
  // marker parser emits a literal chunk — i.e. when text first leaves for
  // TTS. The streaming speaker emits the authoritative `turn.first-audio`
  // on actual playback start (with the same turnId), so both markers live
  // on the timeline and callers can pick whichever boundary fits.
  function noteFirstAudio() {
    if (firstAudioSeen) return
    firstAudioSeen = true
    tracer.emit({
      category: 'greeting.first-audio',
      data: { ms: Date.now() - startTs },
      turnId,
    })
  }

  /**
   * Fallback path — used when the LLM call errors or the first-token
   * timeout fires. Picks a roster line and synthesizes via one-shot
   * speak(). The abort controller is shared, so a caller abort still
   * tears down the TTS.
   */
  async function runFallback(reason: 'timeout' | 'error', message?: string) {
    tracer.emit({
      category: 'greeting.fallback',
      data: { reason, message, kind, lang, characterId: preset.id },
      turnId,
    })
    const line = pickFallback(preset, kind, lang)
    if (!line) return
    onFallbackText?.(line)
    // speak() owns its own AbortController — wire ours in by aborting it
    // on our signal.
    const handle = speak(line, { voiceId, voiceSettings })
    const onAbort = () => handle.abort()
    if (ac.signal.aborted) {
      handle.abort()
    } else {
      ac.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      await handle.promise
    } finally {
      ac.signal.removeEventListener('abort', onAbort)
    }
  }

  const promise = (async () => {
    try {
      const systemPrompt = buildSystemPrompt({
        persona: preset.persona,
        customInstructions,
        memoryBlock,
        gestures: animation?.getGestureIds() ?? [],
        boundEmotions: animation?.getBoundEmotions() ?? [],
      })

      // Session context goes in as a user kickoff message rather than as a
      // system-prompt block. Two reasons:
      //   - xAI (and the `/api/chat` route) reject empty `messages` arrays
      //     — a system prompt alone won't generate a reply.
      //   - Keeping the system prompt byte-identical to normal turns means
      //     greeting calls hit the same prefix cache as chat turns for this
      //     character, instead of invalidating it with an extra tail block.
      //
      // The kickoff is authored IN THE TARGET LANGUAGE. The system prompt's
      // "Reply in the same language the user is using" rule then produces
      // the greeting in that language naturally — a kickoff in English
      // combined with an instruction "reply in Chinese" otherwise loses
      // to the language-mirror rule and comes back in English.
      const kickoff = buildKickoff(kind, lang, visitCount)

      // First-token timeout: if the LLM doesn't start streaming within
      // FIRST_TOKEN_TIMEOUT_MS, abort the fetch and fall through to the
      // static roster. Implemented as a setTimeout that calls ac.abort()
      // — the streamChat AsyncIterable surfaces that as a break on the
      // next iteration tick.
      const firstTokenTimer = setTimeout(() => {
        if (!firstTokenSeen) {
          ac.abort()
        }
      }, FIRST_TOKEN_TIMEOUT_MS)

      let streamErrored: unknown = null
      try {
        const stream = streamChat({
          messages: [{ role: 'user', content: kickoff }],
          systemPrompt,
          signal: ac.signal,
          turnId,
          turnStartTs: startTs,
        })
        for await (const delta of stream) {
          if (ac.signal.aborted) break
          if (!firstTokenSeen) {
            firstTokenSeen = true
            clearTimeout(firstTokenTimer)
            tracer.emit({
              category: 'greeting.first-token',
              data: { ms: Date.now() - startTs },
              turnId,
            })
          }
          await categorizer.consume(delta)
        }
      } catch (err) {
        streamErrored = err
      } finally {
        clearTimeout(firstTokenTimer)
      }

      // Two cases to consider before we decide the happy path succeeded:
      //   a. The abort was our own first-token timeout → fall back.
      //   b. The stream threw and we never saw a token → fall back.
      // In either case we skip the categorizer/marker flush and the
      // onStreamEnd callback because assistantAccum is empty / partial —
      // same discipline as the runTurn abort path (CLAUDE.md gotcha #9).
      if (!firstTokenSeen) {
        // Clean up the speaker's pending TTS state so the fallback doesn't
        // race with any stale in-flight chunks (there shouldn't be any,
        // but belt-and-braces).
        speaker.abort()
        const reason: 'timeout' | 'error' = streamErrored
          ? 'error'
          : 'timeout'
        const message =
          streamErrored instanceof Error
            ? streamErrored.message
            : streamErrored != null
              ? String(streamErrored)
              : undefined
        await runFallback(reason, message)
        return
      }

      // If the caller aborted after we saw the first token, bail without
      // flushing / firing onStreamEnd — the controller will have reset
      // liveAssistant and a re-emit would re-inflate it.
      if (ac.signal.aborted) return

      if (streamErrored) {
        // Partial stream: we got at least one token, then the transport
        // died. Best effort: flush what we have through the parsers so the
        // user hears whatever line the model did finish, then surface the
        // error via a tracer event. Do NOT fall back to the roster here —
        // we'd end up saying two greetings.
        tracer.emit({
          category: 'greeting.fallback',
          data: {
            reason: 'error',
            message:
              streamErrored instanceof Error
                ? streamErrored.message
                : String(streamErrored),
            partial: true,
          },
          turnId,
        })
      }

      await categorizer.flush()
      await marker.flush()
      const tail = audioTagStripper.flush()
      if (tail) {
        assistantAccum += tail
        onAssistantText?.(tail)
      }
      onStreamEnd?.(assistantAccum)

      await speaker.end()
    } finally {
      speaker.abort()
      tracer.emit({
        category: 'greeting.complete',
        data: { durationMs: Date.now() - startTs, characterId: preset.id },
        turnId,
      })
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
