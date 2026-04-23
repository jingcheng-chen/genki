import { synthesize } from '../adapters/tts'
import { chunkText, type ChunkerOptions } from './tts-chunker'
import {
  createPlaybackSource,
  getLipSyncDriver,
  type LipSyncDriver,
} from '../vrm/lip-sync-driver'
import { tracer } from '../observability/tracer'

// ---------------------------------------------------------------------------
// TTS-safe text sanitizer
// ---------------------------------------------------------------------------
//
// ElevenLabs rejects "text that normalizes to empty" with HTTP 400
// (`Input at position 0 has empty text`). This bites us when a chunk is
// made up entirely of non-speakable characters — emoji, pictographs,
// punctuation-only tails ("..."), etc.
//
// Two things happen here:
//   1. Strip characters that don't contribute to speech. Emoji and
//      pictographic symbols read awkwardly even when they don't fail —
//      "🎉" rendered as "party popper" is rarely what the model meant.
//   2. Return null if nothing speakable remains. The caller skips the
//      chunk entirely rather than emitting silence or a 400.
//
// NOTICE:
// We keep letters, numbers, CJK, common punctuation, and whitespace.
// We drop \p{Extended_Pictographic} (emoji) and miscellaneous-symbol
// blocks. Punctuation-only remnants ("...") also fail the speakable
// check because they contain no letter/number/CJK.

const EMOJI_REGEX = /\p{Extended_Pictographic}\p{Emoji_Modifier}?/gu
// Variation selectors (FE0F) and zero-width joiners (200D) are left behind
// when emoji sequences are stripped; clean them too.
const STRIP_REMNANTS = /[\u200D\uFE00-\uFE0F]/g
// Grok occasionally emits raw HTML (e.g. `<span style="color:#00ff00">🐢</span>`)
// even with the no-markup rule in the system prompt. ElevenLabs tokenizes
// those attribute fragments into speakable-but-empty segments and throws a
// 400 "Text for a segment cannot be empty". Strip tags defensively. The
// regex is deliberately simple (no nested tag handling) since the model
// doesn't produce anything that complex.
const HTML_TAG_REGEX = /<\/?[a-zA-Z][^>]*>/g

function sanitizeForTTS(text: string): string | null {
  const stripped = text
    .replace(HTML_TAG_REGEX, '')
    .replace(EMOJI_REGEX, '')
    .replace(STRIP_REMNANTS, '')
  const trimmed = stripped.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  // Must contain at least one letter / number / CJK character — pure
  // punctuation like "..." has no phoneme content and ElevenLabs errors
  // on it unpredictably.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null
  return trimmed
}

/**
 * Sanitize wrapper that emits the before/after text to the tracer so the
 * Turns tab can show a diff between the incoming chunk and the TTS-ready
 * output. The diff is the smoking gun for "why did my reply sound off?" —
 * e.g. an unstripped `<span>🎉</span>` ending up dropped entirely.
 */
function tracedSanitize(text: string, turnId: string | null): string | null {
  tracer.emit({ category: 'tts.sanitize-in', data: { text }, turnId })
  const out = sanitizeForTTS(text)
  tracer.emit({ category: 'tts.sanitize-out', data: { text: out }, turnId })
  return out
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** A running speech session. */
export interface SpeakHandle {
  promise: Promise<void>
  abort: () => void
}

/**
 * Plays a single decoded AudioBuffer through the destination + wlipsync
 * chain. Resolves on `ended` OR on `signal.abort`. Cleans up listeners and
 * disconnects the source no matter how it terminates.
 */
function playBuffer(
  buffer: AudioBuffer,
  driver: LipSyncDriver,
  signal: AbortSignal,
  meta?: { text?: string; turnId?: string | null },
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()

    const source = createPlaybackSource(buffer, driver)
    let settled = false
    const text = meta?.text ?? ''
    const turnId = meta?.turnId ?? null

    const cleanup = () => {
      if (settled) return
      settled = true
      try { source.stop() } catch { /* already stopped */ }
      source.disconnect()
      driver.disconnectSource(source)
      signal.removeEventListener('abort', onAbort)
      source.removeEventListener('ended', onEnd)
    }

    const onEnd = () => {
      tracer.emit({ category: 'tts.playback-end', data: { text }, turnId })
      cleanup()
      resolve()
    }
    const onAbort = () => { cleanup(); resolve() }

    source.addEventListener('ended', onEnd)
    signal.addEventListener('abort', onAbort, { once: true })
    tracer.emit({ category: 'tts.playback-start', data: { text }, turnId })
    source.start()
  })
}

// ---------------------------------------------------------------------------
// One-shot speak: full text known up front (Phase 3 demo flow)
// ---------------------------------------------------------------------------

export function speak(
  text: string,
  options: { voiceId?: string; chunker?: ChunkerOptions } = {},
): SpeakHandle {
  const driver = getLipSyncDriver()
  if (!driver) {
    return {
      promise: Promise.reject(new Error('[speak] Lip-sync driver not ready')),
      abort: () => {},
    }
  }

  const ac = new AbortController()
  const rawChunks = chunkText(text, options.chunker)
  for (const chunk of rawChunks) {
    tracer.emit({ category: 'ttsch.chunk', data: { text: chunk } })
  }
  const chunks = rawChunks
    .map((c) => tracedSanitize(c, null))
    .filter((c): c is string => c !== null)

  // Fire all TTS fetches in parallel — ElevenLabs handles a paragraph's
  // worth of concurrent requests fine. Playback order is preserved by the
  // for-loop below awaiting each promise in sequence.
  const pending: Array<Promise<AudioBuffer | null>> = chunks.map((c) => {
    tracer.emit({
      category: 'tts.request',
      data: { text: c, voiceId: options.voiceId },
    })
    return synthesize(c, { voiceId: options.voiceId, signal: ac.signal })
      .then((buf) => {
        tracer.emit({
          category: 'tts.audio-ready',
          data: { text: c, durationSec: buf.duration },
        })
        return buf
      })
      .catch((e) => {
        if (ac.signal.aborted) return null
        tracer.emit({
          category: 'tts.error',
          data: { message: e instanceof Error ? e.message : String(e) },
        })
        throw e
      })
  })

  const promise = (async () => {
    for (let i = 0; i < pending.length; i++) {
      if (ac.signal.aborted) break
      const buf = await pending[i]
      if (!buf || ac.signal.aborted) continue
      await playBuffer(buf, driver, ac.signal, { text: chunks[i] })
    }
  })()

  return { promise, abort: () => ac.abort() }
}

// ---------------------------------------------------------------------------
// Streaming speaker: text arrives incrementally (Phase 4 LLM flow)
// ---------------------------------------------------------------------------

/**
 * A streaming speaker: feed text deltas via `consume(text)` as they arrive
 * from the LLM; chunks are flushed to TTS on sentence boundaries and
 * played in order. Call `end()` when the LLM is done to synthesize the
 * trailing fragment and wait for playback to finish.
 *
 * Aborts:
 * - `abort()` cancels pending TTS fetches AND stops any currently-playing
 *   buffer. `end()` (or a pending playback) resolves on abort.
 */
export interface StreamingSpeaker {
  consume: (delta: string) => void
  end: () => Promise<void>
  abort: () => void
}

export function createStreamingSpeaker(
  options: {
    voiceId?: string
    chunker?: ChunkerOptions
    turnId?: string | null
    turnStartTs?: number
  } = {},
): StreamingSpeaker {
  const driver = getLipSyncDriver()
  if (!driver) {
    throw new Error('[createStreamingSpeaker] Lip-sync driver not ready')
  }

  const ac = new AbortController()
  const turnId = options.turnId ?? null
  const turnStartTs = options.turnStartTs ?? null

  // Chunker settings mirror the sync speak() path so the text→chunk mapping
  // is consistent whether the caller knows the full text or streams it.
  const boostChunks = options.chunker?.boostChunks ?? 2
  const boostMaxWords = options.chunker?.boostMaxWords ?? 6
  const normalMaxWords = options.chunker?.normalMaxWords ?? 14

  const SENTENCE_TERMINATOR = /[.?!…。！？]\s*$/

  const pendingBuffers: Array<Promise<AudioBuffer | null>> = []
  const chunkTexts: Array<string> = []
  let chunksEmitted = 0
  let buffer = ''
  let firstAudioSeen = false

  // Playback loop runs in the background, draining pendingBuffers as they
  // resolve. We await it in end().
  let playbackIdx = 0
  let playbackPromise: Promise<void> = Promise.resolve()
  const drainOne = async () => {
    if (playbackIdx >= pendingBuffers.length) return
    if (ac.signal.aborted) return
    const i = playbackIdx++
    const p = pendingBuffers[i]
    const text = chunkTexts[i] ?? ''
    const buf = await p
    if (!buf || ac.signal.aborted) return
    // Record "first audio" on the first playback — from the user's point
    // of view, this is when they start hearing something. The `speak`
    // one-shot path doesn't emit this; it's a turn-level stat.
    if (!firstAudioSeen && turnStartTs !== null) {
      firstAudioSeen = true
      tracer.emit({
        category: 'turn.first-audio',
        data: { ms: Date.now() - turnStartTs },
        turnId,
      })
    }
    await playBuffer(buf, driver, ac.signal, { text, turnId })
  }

  function kickPlayback() {
    // Serialize drainOne calls so they run in order.
    playbackPromise = playbackPromise.then(drainOne)
  }

  function flushChunk(text: string) {
    // Emit the pre-sanitize text — this IS the TTS chunker's output. The
    // Turns tab treats `ttsch.chunk` as the pre-sanitizer column.
    tracer.emit({ category: 'ttsch.chunk', data: { text }, turnId })
    const speakable = tracedSanitize(text, turnId)
    if (!speakable) return
    chunksEmitted++
    chunkTexts.push(speakable)
    tracer.emit({
      category: 'tts.request',
      data: { text: speakable, voiceId: options.voiceId },
      turnId,
    })
    pendingBuffers.push(
      synthesize(speakable, {
        voiceId: options.voiceId,
        signal: ac.signal,
      })
        .then((buf) => {
          tracer.emit({
            category: 'tts.audio-ready',
            data: { text: speakable, durationSec: buf.duration },
            turnId,
          })
          return buf
        })
        .catch((e) => {
          if (ac.signal.aborted) return null
          tracer.emit({
            category: 'tts.error',
            data: {
              message: e instanceof Error ? e.message : String(e),
              text: speakable,
            },
            turnId,
          })
          throw e
        }),
    )
    kickPlayback()
  }

  function wordCount(s: string) {
    return s.trim().split(/\s+/).filter(Boolean).length
  }

  function tryFlush() {
    if (!buffer.trim()) return
    const maxWords = chunksEmitted < boostChunks ? boostMaxWords : normalMaxWords

    while (buffer.length > 0) {
      const words = wordCount(buffer)
      const endsSentence = SENTENCE_TERMINATOR.test(buffer)

      if (endsSentence) {
        flushChunk(buffer)
        buffer = ''
        return
      }
      if (words >= maxWords) {
        // No sentence boundary yet — flush the first maxWords and hold the tail.
        const parts = buffer.split(/(\s+)/)
        let taken = 0
        let cut = 0
        for (let i = 0; i < parts.length; i++) {
          if (parts[i].trim()) {
            taken++
            if (taken >= maxWords) {
              cut = i + 1
              break
            }
          }
        }
        flushChunk(parts.slice(0, cut).join(''))
        buffer = parts.slice(cut).join('')
        return
      }
      return
    }
  }

  return {
    consume(delta: string) {
      if (!delta) return
      buffer += delta
      tryFlush()
    },
    async end() {
      if (buffer.trim()) flushChunk(buffer)
      buffer = ''
      await playbackPromise
      // drainOne advances the index; keep draining until done.
      while (playbackIdx < pendingBuffers.length && !ac.signal.aborted) {
        kickPlayback()
        await playbackPromise
      }
    },
    abort() { ac.abort() },
  }
}
