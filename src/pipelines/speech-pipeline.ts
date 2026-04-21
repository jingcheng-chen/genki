import { synthesize } from '../adapters/tts'
import { chunkText, type ChunkerOptions } from './tts-chunker'
import {
  createPlaybackSource,
  getLipSyncDriver,
  type LipSyncDriver,
} from '../vrm/lip-sync-driver'

/**
 * A running "the character is speaking this text" session.
 *
 * - `promise` resolves when every chunk has played through, or rejects on a
 *   non-abort fetch error.
 * - `abort()` cancels in-flight TTS fetches AND stops any currently playing
 *   buffer immediately. Used by the Stop button today, by Phase 5 barge-in
 *   tomorrow.
 */
export interface SpeakHandle {
  promise: Promise<void>
  abort: () => void
}

/**
 * Speaks `text` through the VRM character: chunks it, fires TTS fetches
 * for every chunk in parallel (pipelined), and plays them in order so the
 * character's mouth tracks the audio without gaps between sentences.
 *
 * Requires:
 * - `ensureLipSyncDriver()` previously awaited (audio context resumed,
 *   wlipsync node ready). Throws otherwise.
 */
export function speak(
  text: string,
  options: {
    voiceId?: string
    chunker?: ChunkerOptions
  } = {},
): SpeakHandle {
  const driver = getLipSyncDriver()
  if (!driver) {
    return {
      promise: Promise.reject(
        new Error('[speak] Lip-sync driver not ready — call ensureLipSyncDriver() first'),
      ),
      abort: () => {},
    }
  }

  const ac = new AbortController()
  const chunks = chunkText(text, options.chunker)

  // Pipeline: all TTS fetches start simultaneously. ElevenLabs handles
  // small concurrent request counts fine; a single paragraph is 3-8 chunks.
  // If this grows (>10 chunks) we can add a semaphore here.
  const pending: Array<Promise<AudioBuffer | null>> = chunks.map((chunk) =>
    synthesize(chunk, { voiceId: options.voiceId, signal: ac.signal }).catch((err) => {
      if (ac.signal.aborted) return null
      throw err
    }),
  )

  const promise = (async () => {
    for (const p of pending) {
      if (ac.signal.aborted) break
      const buffer = await p
      if (!buffer || ac.signal.aborted) continue
      await playBuffer(buffer, driver, ac.signal)
    }
  })()

  return { promise, abort: () => ac.abort() }
}

/**
 * Plays a single AudioBuffer through the standard pipeline (destination +
 * wlipsync analyzer), resolving when playback finishes OR the abort signal
 * fires. On abort the source is stopped and disconnected immediately.
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
