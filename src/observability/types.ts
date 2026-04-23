/**
 * Phase 8 — Observability event types.
 *
 * Every traced event is serializable JSON-ish. `data` is per-category;
 * consumers (debug panel tabs) discriminate on `category` and narrow.
 *
 * Philosophy: trace everything interesting at the pipeline boundaries.
 * The #1 user concern is "TTS sounds unnatural" — so the five text
 * pipeline stages (raw LLM delta → post-think → post-marker →
 * TTS chunker → sanitizer) each emit their own category so the Turns
 * tab can diff them stage-by-stage.
 */

/** Keys of every category currently emitted. Add a new key here when
 *  you add a new emit site — keeps the union up-to-date. */
export const TRACE_CATEGORIES = [
  // LLM
  'llm.request',
  'llm.raw-delta',
  'llm.first-token',
  'llm.stream-end',
  'llm.error',

  // Response categorizer (strips <think> / <reasoning>)
  'categorizer.speech',
  'categorizer.reason',

  // Marker parser (splits <|ACT:…|> / <|PLAY:…|> / <|DELAY:…|>)
  'marker.literal',
  'marker.special',

  // TTS pipeline (chunker + sanitizer + fetch + playback)
  'ttsch.chunk',
  'tts.sanitize-in',
  'tts.sanitize-out',
  'tts.request',
  'tts.audio-ready',
  'tts.playback-start',
  'tts.playback-end',
  'tts.error',

  // VAD
  'vad.speech-start',
  'vad.speech-end',
  'vad.misfire',

  // STT
  'stt.request',
  'stt.response',
  'stt.error',

  // Animation
  'anim.emotion',
  'anim.gesture',

  // Memory
  'memory.retrieve',
  'memory.extract-req',
  'memory.extract-res',
  'memory.compact-req',
  'memory.compact-res',
  'memory.error',

  // Turn-level
  'turn.start',
  'turn.first-audio',
  'turn.end',

  // FPS / render loop
  'fps',
] as const

export type TraceCategory = (typeof TRACE_CATEGORIES)[number]

/**
 * Common shape for every event. `turnId` is null for events that
 * don't belong to a turn (fps, standalone errors).
 */
export interface BaseTraceEvent {
  /** Monotonically increasing sequence number assigned by the tracer. */
  seq: number
  /** Wall-clock timestamp (Date.now()). */
  ts: number
  /** Category for tab/filter routing. */
  category: TraceCategory
  /** Turn this event belongs to, if any. */
  turnId: string | null
  /** Free-form payload — discriminated by `category`. */
  data: unknown
}

/**
 * Narrowed per-category event. Use when writing consumers that need
 * typed access to `data`. Falls back to `BaseTraceEvent` for unknown
 * categories.
 */
export type TraceEvent = BaseTraceEvent

// ---------------------------------------------------------------------------
// Category-specific payload shapes. Exported so consumers can narrow.
// ---------------------------------------------------------------------------

export interface LlmRequestData {
  systemPromptLen: number
  messages: Array<{ role: string; contentLen: number }>
  voiceId?: string
  model?: string
}

export interface LlmRawDeltaData {
  delta: string
}

export interface LlmFirstTokenData {
  /** ms from turn.start to first delta. */
  ms: number
}

export interface LlmStreamEndData {
  assistantText: string
  estimatedTokens: number
  durationMs: number
}

export interface ErrorData {
  message: string
  stage?: string
}

export interface CategorizerSpeechData {
  text: string
}
export interface CategorizerReasonData {
  text: string
  tagName: string
}

export interface MarkerLiteralData {
  text: string
}
export interface MarkerSpecialData {
  raw: string
  parsed:
    | { type: 'act'; emotion: string; intensity: number }
    | { type: 'delay'; seconds: number }
    | { type: 'play'; id: string }
    | null
}

export interface TtsChChunkData {
  text: string
}

export interface TtsSanitizeInData {
  text: string
}
export interface TtsSanitizeOutData {
  text: string | null
}

export interface TtsRequestData {
  text: string
  voiceId?: string
}
export interface TtsAudioReadyData {
  text: string
  durationSec: number
}
export interface TtsPlaybackData {
  text: string
}

export interface VadSpeechEndData {
  samples: number
}

export interface SttRequestData {
  bytes: number
  languageCode?: string
}
export interface SttResponseData {
  text: string
  languageCode: string | null
}

export interface AnimEmotionData {
  emotion: string
  intensity: number
  bound: boolean
}
export interface AnimGestureData {
  id: string
  started: boolean
}

export interface MemoryRetrieveData {
  characterId: string
  factCount: number
  retrievedIds: string[]
}
export interface MemoryExtractReqData {
  characterId: string
  userTurnLen: number
  assistantTurnLen: number
}
export interface MemoryExtractResData {
  new: number
  reinforced: number
  outdated: number
}
export interface MemoryCompactReqData {
  characterId: string
  factId: string
  targetWords: number
}
export interface MemoryCompactResData {
  factId: string
  fromLen: number
  toLen: number
}

export interface TurnStartData {
  userText: string
  characterId: string
}
export interface TurnFirstAudioData {
  ms: number
}
export interface TurnEndData {
  totalMs: number
  stages: {
    llmFirstTokenMs: number | null
    ttsFirstAudioMs: number | null
    totalMs: number
  }
}

export interface FpsData {
  fps: number
  frameMs: number
}
