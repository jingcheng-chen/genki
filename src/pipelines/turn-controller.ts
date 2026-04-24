import { runTurn, type TurnHandle } from './turn'
import { transcribe } from '../adapters/stt'
import { createMicVAD, type VadHandle } from '../audio/vad'
import type { ChatMessage } from '../adapters/llm'
import { buildMemoryBlock } from '../memory/retriever'
import { enqueueExtraction } from '../memory/extractor'
import { maybeRunCompaction } from '../memory/compactor'
import { tracer } from '../observability/tracer'
import { getActiveAnimationController } from '../vrm/animation-controller'
import { runGreeting, type GreetingHandle } from './greeting'
import { detectLanguage, resolveSessionLang } from './language'
import { useCharacterStore } from '../stores/character'
import { getPreset } from '../vrm/presets'
import type { CharacterVoiceSettings } from '../vrm/presets/types'

/**
 * Phase 5 orchestrator — owns the mic VAD, the live transcript, the chat
 * history, and the currently-running `TurnHandle`. It's a small state
 * machine that the UI drives through a narrow API.
 *
 * The shape maps 1:1 to the diagram in §6.1 of PLAN.md:
 *
 *   IDLE ──(speech-start)──▶ LISTENING
 *   LISTENING ──(speech-end)──▶ TRANSCRIBING
 *   TRANSCRIBING ──(stt ok)──▶ THINKING ──(first delta)──▶ SPEAKING
 *   SPEAKING ──(playback done)──▶ IDLE
 *   SPEAKING ──(barge-in: speech-start + 500ms grace)──▶ LISTENING
 *
 * Barge-in is the one non-obvious transition and is implemented with a
 * cancellable grace timer so a cough / laugh doesn't truncate a sentence.
 */

export type TurnState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'

/**
 * Per-turn preset snapshot — the persona/voice/custom-instructions the
 * turn controller should use for the NEXT LLM call. Callers pass a
 * getter, not a fixed value, so the controller always sees the freshest
 * store state (e.g. right after the user flipped between Mika and Ani).
 */
export interface TurnPreset {
  /** Preset id — used as the memory file key. */
  id: string
  persona: string
  customInstructions?: string
  voiceId?: string
  voiceSettings?: CharacterVoiceSettings
}

export interface TurnControllerOptions {
  /** ISO language hint forwarded to Scribe. Leave undefined for auto. */
  language?: string
  /** Called once per turn to resolve the active character's persona + voice. */
  getPreset: () => TurnPreset
}

export interface AssistantEmotionMark {
  name: string
  intensity: number
}

export interface UITurn {
  role: 'user' | 'assistant'
  content: string
  emotions?: AssistantEmotionMark[]
  /** True if the assistant was cut off mid-reply by a barge-in. Used for
   *  the `[interrupted]` suffix shown in the transcript (and for the LLM's
   *  own context on the next turn). */
  interrupted?: boolean
}

export type TurnControllerEvent =
  | { type: 'state'; state: TurnState }
  | { type: 'history' }
  | { type: 'assistant-delta'; text: string }
  | { type: 'emotion'; name: string; intensity: number }
  | { type: 'gesture'; id: string }
  | { type: 'error'; message: string }
  | { type: 'greeting'; active: boolean }

export interface TurnController {
  getState: () => TurnState
  getHistory: () => UITurn[]
  getLiveAssistant: () => string
  isMicOn: () => boolean

  startMic: () => Promise<void>
  stopMic: () => Promise<void>

  sendText: (text: string) => void
  /**
   * Generate and speak a greeting via the full LLM pipeline. Kicks off a
   * "noticing" gesture (peek for starters, look_around for returners) at
   * call time to mask the ~1.3s first-audio gap, then runs the LLM through
   * the same categorizer / marker / TTS chain as normal turns.
   *
   * Falls through silently when another turn is already in flight or when
   * the controller isn't at rest. On LLM error or 5s first-token timeout,
   * the pipeline internally falls back to the preset's static roster line.
   *
   * Reports `true` while the greeting is pending so the UI can render a
   * typing indicator.
   */
  runGreeting: () => Promise<void>
  /** True while a greeting is actively being generated / spoken. Used by
   *  the chat panel to render a typing indicator during the LLM gap. */
  isGreeting: () => boolean
  abort: () => void
  clearHistory: () => void

  subscribe: (listener: (ev: TurnControllerEvent) => void) => () => void

  destroy: () => Promise<void>
}

const BARGE_IN_GRACE_MS = 500

/**
 * How long the controller sits idle (post-assistant-turn) before the
 * character proactively speaks up to break the silence. A full conversation
 * beat is ~3-8s; past 20s the user has usually drifted away or is waiting
 * for us to say something. 25s is a comfortable middle.
 */
const PROACTIVE_IDLE_MS = 25_000

export function createTurnController(
  options: TurnControllerOptions,
): TurnController {
  let state: TurnState = 'idle'
  const history: UITurn[] = []
  let liveAssistant = ''
  let liveEmotions: AssistantEmotionMark[] = []

  let vad: VadHandle | null = null
  let micOn = false

  let currentTurn: TurnHandle | null = null
  let currentGreeting: GreetingHandle | null = null
  let greetingActive = false
  let bargeInTimer: ReturnType<typeof setTimeout> | null = null
  // Idle-break ("the user has been quiet") timer. Scheduled on entry to
  // `idle` when the last history entry is an assistant turn; cancelled on
  // any non-idle transition or user action. `firedThisWindow` keeps us to
  // at most one proactive per silence window — the window resets when the
  // user next acts (speak / type / clear / barge-in).
  let proactiveTimer: ReturnType<typeof setTimeout> | null = null
  let proactiveFiredThisWindow = false

  const listeners = new Set<(ev: TurnControllerEvent) => void>()

  function emit(ev: TurnControllerEvent) {
    for (const l of listeners) l(ev)
  }

  function setState(next: TurnState) {
    if (state === next) return
    const prev = state
    state = next
    // Drive the animation controller's talking chain off the state
    // transition: entering 'speaking' starts the chain, leaving it (to any
    // other state — idle, listening, transcribing) stops it. Using the
    // single setState choke point means every path (normal reply, greeting,
    // abort, barge-in, error) triggers the animation swap correctly without
    // us having to remember to call it at each site.
    //
    // `getActiveAnimationController()` may return null before the VRM has
    // mounted; the nullable access makes this a no-op during cold start.
    if (next === 'speaking' && prev !== 'speaking') {
      getActiveAnimationController()?.startSpeaking()
    } else if (prev === 'speaking' && next !== 'speaking') {
      getActiveAnimationController()?.stopSpeaking()
    }
    // Silence-break scheduling piggybacks on setState so every path that
    // reaches idle starts the timer, and every path that leaves idle
    // cancels it. No other site needs to know the timer exists.
    if (next === 'idle') scheduleProactive()
    else cancelProactive()
    emit({ type: 'state', state: next })
  }

  function cancelProactive() {
    if (proactiveTimer !== null) {
      clearTimeout(proactiveTimer)
      proactiveTimer = null
    }
  }

  function scheduleProactive() {
    cancelProactive()
    if (proactiveFiredThisWindow) return
    if (history.length === 0) return
    // Only when we're waiting on the user — if the last entry is the user's
    // own turn, we've already replied's been-committed-to by a higher level.
    const last = history[history.length - 1]
    if (last.role !== 'assistant') return
    proactiveTimer = setTimeout(() => {
      proactiveTimer = null
      void runProactiveTurn()
    }, PROACTIVE_IDLE_MS)
  }

  function cancelBargeInTimer() {
    if (bargeInTimer !== null) {
      clearTimeout(bargeInTimer)
      bargeInTimer = null
    }
  }

  function commitInterruptedAssistant() {
    const partial = liveAssistant.trim()
    if (!partial) return
    history.push({
      role: 'assistant',
      content: `${partial} [interrupted]`,
      emotions: liveEmotions.length ? [...liveEmotions] : undefined,
      interrupted: true,
    })
    // Same ordering as onStreamEnd — reset the live preview BEFORE the
    // history emit so subscribers don't render the partial bubble a
    // second time as a "live" preview alongside the just-pushed history
    // entry.
    liveAssistant = ''
    liveEmotions = []
    emit({ type: 'history' })
  }

  function resetLive() {
    liveAssistant = ''
    liveEmotions = []
  }

  /**
   * Barge-in confirmed (grace timer fired). Abort the in-flight LLM+TTS,
   * push the partial assistant reply into history with an `[interrupted]`
   * tag so the model sees it on the next turn, then sit in LISTENING — the
   * VAD's still-open speech segment becomes the next user turn when it
   * ends.
   */
  function fireBargeIn() {
    bargeInTimer = null
    commitInterruptedAssistant()
    currentTurn?.abort()
    currentTurn = null
    // A greeting playing when the user starts talking should stop the
    // same way an LLM turn does — the LLM-generated path has already
    // streamed literals into liveAssistant and may have pushed the
    // completed entry; the fallback path pushes the whole line at once.
    // commitInterruptedAssistant above handles the in-flight case.
    currentGreeting?.abort()
    currentGreeting = null
    if (greetingActive) {
      greetingActive = false
      emit({ type: 'greeting', active: false })
    }
    resetLive()
    setState('listening')
  }

  async function handleUserInput(opts: { audio?: Float32Array; text?: string }) {
    // If anything is in flight, cancel it first. For the typed-input path
    // this cleanly aborts a still-speaking assistant before starting the
    // next turn.
    if (currentTurn) {
      commitInterruptedAssistant()
      currentTurn.abort()
      currentTurn = null
      resetLive()
    }
    if (currentGreeting) {
      currentGreeting.abort()
      currentGreeting = null
      if (greetingActive) {
        greetingActive = false
        emit({ type: 'greeting', active: false })
      }
    }

    let userText = opts.text ?? ''

    if (opts.audio) {
      setState('transcribing')
      try {
        // Estimate request byte size: Float32 samples → wav pcm16 is half.
        tracer.emit({
          category: 'stt.request',
          data: { bytes: opts.audio.length * 2, languageCode: options.language },
        })
        const { text, languageCode } = await transcribe(opts.audio, 16000, {
          language: options.language,
        })
        tracer.emit({
          category: 'stt.response',
          data: { text, languageCode },
        })
        userText = text
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        tracer.emit({ category: 'stt.error', data: { message } })
        emit({ type: 'error', message })
        setState('idle')
        return
      }
    }

    const trimmed = userText.trim()
    if (!trimmed) {
      // Empty transcript / empty text input — drop back to idle. The mic
      // (if on) keeps listening for the next utterance.
      setState('idle')
      return
    }

    history.push({ role: 'user', content: trimmed })
    // User has acted — the current silence window ends here. Next time we
    // return to idle with an assistant tail, a fresh proactive can fire.
    proactiveFiredThisWindow = false
    // Sniff the language of the user's turn and persist it. Cheap regex —
    // CJK wins over latin when both are present. `null` returns leave the
    // last-observed value alone (e.g. numbers-only / emoji-only turns).
    const detectedLang = detectLanguage(trimmed)
    if (detectedLang) {
      useCharacterStore.getState().setLastUserLang(detectedLang)
    }
    emit({ type: 'history' })

    setState('thinking')

    const preset = options.getPreset()
    const turnId = makeTurnId()
    const turnStartTs = Date.now()

    tracer.emit({
      category: 'turn.start',
      data: { userText: trimmed, characterId: preset.id },
      turnId,
    })

    // Assemble the memory block for this turn. A failed load shouldn't
    // take down the conversation — log and proceed with an empty block.
    let memoryBlock = ''
    let retrievedFactIds: string[] = []
    try {
      const memo = await buildMemoryBlock(preset.id)
      memoryBlock = memo.text
      retrievedFactIds = memo.retrievedFactIds
      tracer.emit({
        category: 'memory.retrieve',
        data: {
          characterId: preset.id,
          factCount: retrievedFactIds.length,
          retrievedIds: retrievedFactIds,
        },
        turnId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[turn-controller] memory load failed', message)
      tracer.emit({
        category: 'memory.error',
        data: { message, stage: 'retrieve' },
        turnId,
      })
    }

    const handle = runTurn({
      turnId,
      turnStartTs,
      messages: history.map((t) => ({ role: t.role, content: t.content })),
      persona: preset.persona,
      customInstructions: preset.customInstructions,
      memoryBlock,
      retrievedFactIds,
      voiceId: preset.voiceId,
      voiceSettings: preset.voiceSettings,
      onAssistantText: (delta) => {
        if (state === 'thinking') setState('speaking')
        liveAssistant += delta
        emit({ type: 'assistant-delta', text: delta })
      },
      onEmotion: (name, intensity) => {
        liveEmotions.push({ name, intensity })
        emit({ type: 'emotion', name, intensity })
      },
      onGesture: (id) => {
        emit({ type: 'gesture', id })
      },
      onStreamEnd: () => {
        // Order matters: clear `liveAssistant` BEFORE emitting so React's
        // `history` listener doesn't see the old live-preview text and
        // render a second bubble on top of the just-pushed history entry.
        history.push({
          role: 'assistant',
          content: liveAssistant,
          emotions: liveEmotions.length ? [...liveEmotions] : undefined,
        })
        resetLive()
        emit({ type: 'history' })
      },
      onTurnComplete: ({ userTurn, assistantTurn }) => {
        // Fire-and-forget background extraction + compaction. The
        // retriever-picked ids go to the extractor so it knows what
        // was in context; the compactor is turn-counter-driven and
        // doesn't need the ids.
        if (assistantTurn.trim()) {
          enqueueExtraction({
            characterId: preset.id,
            userTurn,
            assistantTurn,
            retrievedFactIds,
          })
          maybeRunCompaction(preset.id)
        }
      },
    })
    currentTurn = handle

    try {
      await handle.promise
    } catch (err) {
      emit({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (currentTurn === handle) {
        currentTurn = null
        // A barge-in transitions us to LISTENING inside fireBargeIn — don't
        // trample that here.
        if (state !== 'listening') setState('idle')
      }
      // Emit `turn.end` outside the happy-path branch so aborted + errored
      // turns still show up on the Turns tab with a total duration.
      tracer.emit({
        category: 'turn.end',
        data: {
          totalMs: Date.now() - turnStartTs,
          stages: {
            llmFetchSentMs: null,
            llmFirstByteMs: null,
            llmFirstTokenMs: null,
            ttsFirstAudioMs: null,
            totalMs: Date.now() - turnStartTs,
          },
        },
        turnId,
      })
    }
  }

  /**
   * Silence-break turn: no user input, same LLM pipeline, but the system
   * prompt gains a small "user went quiet, speak up gently" directive
   * (see `buildSystemPrompt`'s `proactiveReason`). Skips memory extraction
   * because there's no user utterance to anchor facts against.
   *
   * Firing is gated at the scheduler; this function is the inner "actually
   * run it" with the same defensive re-checks so a stray fire after state
   * drift (e.g. a user turn started in the gap between setTimeout and this
   * function) still no-ops cleanly.
   */
  async function runProactiveTurn() {
    if (currentTurn || currentGreeting) return
    if (state !== 'idle') return
    if (history.length === 0) return
    const last = history[history.length - 1]
    if (last.role !== 'assistant') return
    if (proactiveFiredThisWindow) return
    proactiveFiredThisWindow = true

    const preset = options.getPreset()
    const turnId = makeTurnId()
    const turnStartTs = Date.now()
    setState('thinking')

    tracer.emit({
      category: 'turn.start',
      data: { characterId: preset.id, proactive: 'silence' },
      turnId,
    })

    let memoryBlock = ''
    let retrievedFactIds: string[] = []
    try {
      const memo = await buildMemoryBlock(preset.id)
      memoryBlock = memo.text
      retrievedFactIds = memo.retrievedFactIds
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[turn-controller] memory load failed (proactive)', message)
      tracer.emit({
        category: 'memory.error',
        data: { message, stage: 'retrieve' },
        turnId,
      })
    }

    const handle = runTurn({
      turnId,
      turnStartTs,
      messages: history.map((t) => ({ role: t.role, content: t.content })),
      persona: preset.persona,
      customInstructions: preset.customInstructions,
      memoryBlock,
      retrievedFactIds,
      voiceId: preset.voiceId,
      voiceSettings: preset.voiceSettings,
      proactiveReason: 'silence',
      onAssistantText: (delta) => {
        if (state === 'thinking') setState('speaking')
        liveAssistant += delta
        emit({ type: 'assistant-delta', text: delta })
      },
      onEmotion: (name, intensity) => {
        liveEmotions.push({ name, intensity })
        emit({ type: 'emotion', name, intensity })
      },
      onGesture: (id) => {
        emit({ type: 'gesture', id })
      },
      onStreamEnd: () => {
        history.push({
          role: 'assistant',
          content: liveAssistant,
          emotions: liveEmotions.length ? [...liveEmotions] : undefined,
        })
        resetLive()
        emit({ type: 'history' })
      },
      // Deliberately no `onTurnComplete` — memory extraction needs a user
      // turn to anchor facts, and a silence-break has none. Skipping is
      // the safe default; we can revisit if we want the character's own
      // musings treated as extractable facts later.
    })
    currentTurn = handle

    try {
      await handle.promise
    } catch (err) {
      emit({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (currentTurn === handle) {
        currentTurn = null
        // TS narrowed `state` to 'idle' via the early guard above and cannot
        // see that callbacks + setState() widened it back during await; the
        // cast restores the full `TurnState` for the comparison. Mirrors the
        // barge-in exemption in handleUserInput.
        if ((state as TurnState) !== 'listening') setState('idle')
      }
      tracer.emit({
        category: 'turn.end',
        data: {
          totalMs: Date.now() - turnStartTs,
          stages: {
            llmFetchSentMs: null,
            llmFirstByteMs: null,
            llmFirstTokenMs: null,
            ttsFirstAudioMs: null,
            totalMs: Date.now() - turnStartTs,
          },
        },
        turnId,
      })
    }
  }

  /**
   * Generates a per-turn opaque id used to group tracer events. Short
   * random hex is plenty — the tracer ring buffer caps at 1000 entries,
   * collisions across sessions are fine.
   */
  function makeTurnId(): string {
    const rand = Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, '0')
    return `t_${Date.now().toString(36)}_${rand}`
  }

  // -------------------------------------------------------------------------
  // VAD callbacks
  // -------------------------------------------------------------------------

  function onSpeechStart() {
    if (state === 'speaking') {
      // Possible barge-in. Give the user 500ms to prove they mean it before
      // we kill the assistant's turn. onSpeechEnd or onMisfire will cancel.
      if (bargeInTimer === null) {
        bargeInTimer = setTimeout(fireBargeIn, BARGE_IN_GRACE_MS)
      }
      return
    }
    // Normal user-turn start. Skip if we're already downstream of listening.
    if (state === 'idle') setState('listening')
  }

  function onSpeechEnd(audio: Float32Array) {
    if (bargeInTimer !== null) {
      // False-positive barge-in: user's sound was shorter than the grace
      // window. Let the assistant keep speaking and discard the audio.
      cancelBargeInTimer()
      return
    }
    if (state !== 'listening') return
    void handleUserInput({ audio })
  }

  function onMisfire() {
    cancelBargeInTimer()
    if (state === 'listening') setState('idle')
  }

  function onVadError(message: string) {
    emit({ type: 'error', message: `[vad] ${message}` })
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  return {
    getState: () => state,
    getHistory: () => history.slice(),
    getLiveAssistant: () => liveAssistant,
    isMicOn: () => micOn,

    async startMic() {
      if (micOn) return
      if (!vad) {
        vad = await createMicVAD({
          onSpeechStart,
          onSpeechEnd,
          onMisfire,
          onError: onVadError,
        })
      }
      await vad.start()
      micOn = true
    },

    async stopMic() {
      if (!vad || !micOn) return
      await vad.pause()
      micOn = false
      cancelBargeInTimer()
      if (state === 'listening') setState('idle')
    },

    sendText(text) {
      void handleUserInput({ text })
    },

    async runGreeting() {
      // Only greet when nothing else is in flight — we don't want a
      // greeting colliding with an assistant turn the user just kicked
      // off, and we don't want to interrupt the user's own speech.
      if (currentTurn || currentGreeting) return
      if (state !== 'idle') return

      const turnPreset = options.getPreset()
      // The greeting pipeline needs the full preset (starters / returners
      // rosters, defaultLanguage). TurnPreset is a thin snapshot, so
      // re-resolve the full preset from the registry here.
      const fullPreset = getPreset(turnPreset.id)
      const store = useCharacterStore.getState()
      const visitCount = store.greetedPresets[turnPreset.id] ?? 0
      const kind: 'starter' | 'returner' = visitCount === 0 ? 'starter' : 'returner'
      const lang = resolveSessionLang(fullPreset, store.lastUserLang)

      // Record the greeting BEFORE the async work so a quick second
      // invocation (e.g. a re-mount during hot-reload) can't double-fire.
      store.recordGreeting(turnPreset.id)

      // "Noticing" gesture — fires immediately to mask the ~1.3s first-
      // audio gap. Peek reads as "first glance" for a starter;
      // look_around reads as "scanning the room" for a returner.
      const anim = getActiveAnimationController()
      anim?.play(kind === 'starter' ? 'peek' : 'look_around')

      setState('thinking')
      greetingActive = true
      emit({ type: 'greeting', active: true })

      // Build the memory block just like a normal turn. Memory on the
      // greeting is especially nice — the character gets to refer back to
      // what they remember about the user in their opener.
      let memoryBlock = ''
      try {
        const memo = await buildMemoryBlock(turnPreset.id)
        memoryBlock = memo.text
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[turn-controller] memory load failed (greeting)', message)
      }

      const handle = runGreeting({
        kind,
        lang,
        visitCount,
        preset: fullPreset,
        customInstructions: turnPreset.customInstructions,
        memoryBlock,
        voiceId: turnPreset.voiceId,
        voiceSettings: turnPreset.voiceSettings,
        onAssistantText: (delta) => {
          if (state === 'thinking') setState('speaking')
          liveAssistant += delta
          emit({ type: 'assistant-delta', text: delta })
        },
        onEmotion: (name, intensity) => {
          liveEmotions.push({ name, intensity })
          emit({ type: 'emotion', name, intensity })
        },
        onGesture: (id) => {
          emit({ type: 'gesture', id })
        },
        onStreamEnd: () => {
          // Same reset-before-emit discipline as runTurn's onStreamEnd —
          // otherwise subscribers would render the partial live preview
          // alongside the just-pushed history entry.
          history.push({
            role: 'assistant',
            content: liveAssistant,
            emotions: liveEmotions.length ? [...liveEmotions] : undefined,
          })
          resetLive()
          emit({ type: 'history' })
        },
        onFallbackText: (text) => {
          // Static-fallback path — the greeting pipeline didn't get a
          // first token, so it picked a roster line. Push it whole; no
          // markers or emotions to track.
          history.push({ role: 'assistant', content: text })
          emit({ type: 'history' })
          if (state === 'thinking') setState('speaking')
        },
      })
      currentGreeting = handle

      try {
        await handle.promise
      } catch (err) {
        emit({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        if (currentGreeting === handle) {
          currentGreeting = null
          greetingActive = false
          emit({ type: 'greeting', active: false })
          if ((state as TurnState) !== 'listening') setState('idle')
        } else {
          // Ownership was stolen (abort / barge-in cleared it); still make
          // sure the indicator drops.
          greetingActive = false
          emit({ type: 'greeting', active: false })
        }
      }
    },

    isGreeting: () => greetingActive,

    abort() {
      cancelBargeInTimer()
      commitInterruptedAssistant()
      currentTurn?.abort()
      currentTurn = null
      currentGreeting?.abort()
      currentGreeting = null
      if (greetingActive) {
        greetingActive = false
        emit({ type: 'greeting', active: false })
      }
      resetLive()
      setState('idle')
    },

    clearHistory() {
      history.length = 0
      resetLive()
      cancelProactive()
      proactiveFiredThisWindow = false
      emit({ type: 'history' })
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async destroy() {
      cancelBargeInTimer()
      cancelProactive()
      currentTurn?.abort()
      currentTurn = null
      currentGreeting?.abort()
      currentGreeting = null
      greetingActive = false
      if (vad) {
        await vad.destroy()
        vad = null
      }
      micOn = false
      listeners.clear()
    },
  }
}

export type { ChatMessage }
