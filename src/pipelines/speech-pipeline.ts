import { synthesize } from '../adapters/tts'
import { chunkText, type ChunkerOptions } from './tts-chunker'
import {
  createPlaybackSource,
  getLipSyncDriver,
  type LipSyncDriver,
} from '../vrm/lip-sync-driver'

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
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()

    const source = createPlaybackSource(buffer, driver)
    let settled = false

    const cleanup = () => {
      if (settled) return
      settled = true
      try { source.stop() } catch { /* already stopped */ }
      source.disconnect()
      driver.disconnectSource(source)
      signal.removeEventListener('abort', onAbort)
      source.removeEventListener('ended', onEnd)
    }

    const onEnd = () => { cleanup(); resolve() }
    const onAbort = () => { cleanup(); resolve() }

    source.addEventListener('ended', onEnd)
    signal.addEventListener('abort', onAbort, { once: true })
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
  const chunks = chunkText(text, options.chunker)

  // Fire all TTS fetches in parallel — ElevenLabs handles a paragraph's
  // worth of concurrent requests fine. Playback order is preserved by the
  // for-loop below awaiting each promise in sequence.
  const pending: Array<Promise<AudioBuffer | null>> = chunks.map((c) =>
    synthesize(c, { voiceId: options.voiceId, signal: ac.signal }).catch((e) => {
      if (ac.signal.aborted) return null
      throw e
    }),
  )

  const promise = (async () => {
    for (const p of pending) {
      if (ac.signal.aborted) break
      const buf = await p
      if (!buf || ac.signal.aborted) continue
      await playBuffer(buf, driver, ac.signal)
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
  options: { voiceId?: string; chunker?: ChunkerOptions } = {},
): StreamingSpeaker {
  const driver = getLipSyncDriver()
  if (!driver) {
    throw new Error('[createStreamingSpeaker] Lip-sync driver not ready')
  }

  const ac = new AbortController()

  // Chunker settings mirror the sync speak() path so the text→chunk mapping
  // is consistent whether the caller knows the full text or streams it.
  const boostChunks = options.chunker?.boostChunks ?? 2
  const boostMaxWords = options.chunker?.boostMaxWords ?? 6
  const normalMaxWords = options.chunker?.normalMaxWords ?? 14

  const SENTENCE_TERMINATOR = /[.?!…。！？]\s*$/

  const pendingBuffers: Array<Promise<AudioBuffer | null>> = []
  let chunksEmitted = 0
  let buffer = ''

  // Playback loop runs in the background, draining pendingBuffers as they
  // resolve. We await it in end().
  let playbackIdx = 0
  let playbackPromise: Promise<void> = Promise.resolve()
  const drainOne = async () => {
    if (playbackIdx >= pendingBuffers.length) return
    if (ac.signal.aborted) return
    const p = pendingBuffers[playbackIdx++]
    const buf = await p
    if (!buf || ac.signal.aborted) return
    await playBuffer(buf, driver, ac.signal)
  }

  function kickPlayback() {
    // Serialize drainOne calls so they run in order.
    playbackPromise = playbackPromise.then(drainOne)
  }

  function flushChunk(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    chunksEmitted++
    pendingBuffers.push(
      synthesize(trimmed, {
        voiceId: options.voiceId,
        signal: ac.signal,
      }).catch((e) => {
        if (ac.signal.aborted) return null
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
