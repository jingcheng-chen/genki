import { MicVAD } from '@ricky0123/vad-web'
import { getAudioContext, resumeAudioContext } from './context'

/**
 * Thin wrapper around @ricky0123/vad-web's `MicVAD`.
 *
 * Two reasons for the wrapper:
 *   1. Lock the asset paths (`baseAssetPath`, `onnxWASMBasePath`) to the
 *      same-origin `/vad/` and `/ort/` we populated at install time —
 *      Chromium rejects worklet scripts fetched from data: or cross-origin
 *      URLs, same failure mode we hit with wlipsync in Phase 2.
 *   2. Share the app's `AudioContext`. VAD tries to create its own if we
 *      don't hand it one, which leads to two contexts running side-by-side
 *      and an autoplay-policy re-prompt on some browsers.
 */

export interface VadCallbacks {
  onSpeechStart?: () => void
  /** Called with the 16 kHz Float32 segment when VAD decides it was real speech. */
  onSpeechEnd?: (audio: Float32Array) => void
  /** Called when speech was detected but too short to be considered real. */
  onMisfire?: () => void
  /** Surfaced so the UI can render a recoverable banner (rare in practice). */
  onError?: (message: string) => void
}

export interface VadHandle {
  start: () => Promise<void>
  pause: () => Promise<void>
  destroy: () => Promise<void>
  /** Sample rate of the audio delivered by `onSpeechEnd`. Always 16000. */
  readonly sampleRate: 16000
}

/**
 * Lazily creates and initializes a MicVAD. The promise resolves once the
 * ONNX model is compiled and the mic permission is granted; callers should
 * render a "requesting mic…" state until this resolves.
 */
export async function createMicVAD(callbacks: VadCallbacks): Promise<VadHandle> {
  const audioContext = getAudioContext()

  const vad = await MicVAD.new({
    audioContext,
    model: 'v5',
    baseAssetPath: '/vad/',
    onnxWASMBasePath: '/ort/',
    // Defaults: 512 samples per frame, ~32ms; thresholds tuned by the lib
    // author. We don't override them — re-tuning VAD is an art project we
    // don't need yet.
    startOnLoad: false,
    onSpeechStart: () => callbacks.onSpeechStart?.(),
    onSpeechEnd: (audio) => callbacks.onSpeechEnd?.(audio),
    onVADMisfire: () => callbacks.onMisfire?.(),
  })

  return {
    start: async () => {
      // MicVAD was constructed while the shared context may still have
      // been suspended; resume it now that we're inside the user-gesture
      // handler that called `startMic()`.
      await resumeAudioContext()
      await vad.start()
    },
    pause: () => vad.pause(),
    destroy: () => vad.destroy(),
    sampleRate: 16000,
  }
}
