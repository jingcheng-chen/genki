/**
 * Shared AudioContext singleton.
 *
 * Browsers block AudioContext.start() until a user gesture. We create the
 * context lazily but DO NOT auto-resume — call `resumeAudioContext()` from
 * a click/keydown handler, not from module init.
 */

let ctx: AudioContext | null = null

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' })
  }
  return ctx
}

/**
 * Must be called from inside a user-gesture handler (click, keydown, …).
 * Subsequent calls are no-ops once the context is running.
 */
export async function resumeAudioContext(): Promise<AudioContext> {
  const c = getAudioContext()
  if (c.state === 'suspended') {
    await c.resume()
  }
  return c
}

/**
 * Decode an audio File (mp3/wav/ogg/…) into an AudioBuffer using the shared
 * AudioContext. Phase 2 debug UI uses this; Phase 3 TTS fetches will feed
 * the same `decodeAudioData` path.
 */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer()
  const c = getAudioContext()
  return await c.decodeAudioData(bytes)
}
