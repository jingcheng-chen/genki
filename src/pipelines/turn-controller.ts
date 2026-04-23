import { runTurn, type TurnHandle } from './turn'
import { transcribe } from '../adapters/stt'
import { createMicVAD, type VadHandle } from '../audio/vad'
import type { ChatMessage } from '../adapters/llm'
import { buildMemoryBlock } from '../memory/retriever'
import { enqueueExtraction } from '../memory/extractor'
import { maybeRunCompaction } from '../memory/compactor'
import { tracer } from '../observability/tracer'

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

export interface TurnController {
  getState: () => TurnState
  getHistory: () => UITurn[]
  getLiveAssistant: () => string
  isMicOn: () => boolean

  startMic: () => Promise<void>
  stopMic: () => Promise<void>

  sendText: (text: string) => void
  abort: () => void
  clearHistory: () => void

  subscribe: (listener: (ev: TurnControllerEvent) => void) => () => void

  destroy: () => Promise<void>
}

const BARGE_IN_GRACE_MS = 500

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
  let bargeInTimer: ReturnType<typeof setTimeout> | null = null

  const listeners = new Set<(ev: TurnControllerEvent) => void>()

  function emit(ev: TurnControllerEvent) {
    for (const l of listeners) l(ev)
  }

  function setState(next: TurnState) {
    if (state === next) return
    state = next
    emit({ type: 'state', state: next })
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

    abort() {
      cancelBargeInTimer()
      commitInterruptedAssistant()
      currentTurn?.abort()
      currentTurn = null
      resetLive()
      setState('idle')
    },

    clearHistory() {
      history.length = 0
      resetLive()
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
      currentTurn?.abort()
      currentTurn = null
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
