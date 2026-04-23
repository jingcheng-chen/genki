import { create } from 'zustand'

/**
 * Phase 10 — Scene loading state machine.
 *
 * Drives the StartGate modal copy/progress, wires into the VRM loader's
 * progress callback, and exposes a single `ready` flag the rest of the UI
 * can gate on.
 *
 * The happy path:
 *
 *   idle
 *     -> rehydrating         (character store unbundled from localStorage)
 *     -> audio-initializing  (user clicked Start; AudioContext.resume + wlipsync)
 *     -> loading-vrm (%)     (VRM + VRMA fetch in progress)
 *     -> binding             (animation controller + VRMUtils prep)
 *     -> ready               (normal runtime — StartGate dismisses)
 *
 * On fatal failure any state can transition to `error`. Retry calls
 * `reset()` which returns to `idle`.
 *
 * Not persisted — it's a derived runtime state, re-entering on reload
 * is fine and desired.
 */

export type SceneStatus =
  | 'idle'
  | 'rehydrating'
  | 'audio-initializing'
  | 'loading-vrm'
  | 'binding'
  | 'ready'
  | 'error'

export interface SceneState {
  status: SceneStatus
  /** 0..1 fraction of the VRM + animations that have finished fetching.
   *  Only meaningful while `status === 'loading-vrm'`. Outside that window
   *  it's allowed to be stale. */
  vrmProgress: number
  errorMessage: string | null
  /**
   * Flips true exactly once per page load, right after `ensureLipSyncDriver()`
   * resolves in StartGate. Consumers that need "the lip-sync driver is
   * bound and the AudioContext is running" should gate on this flag —
   * `status === 'ready'` is ambiguous because the state machine lands on
   * `ready` twice (once after VRM parse, then again after audio init).
   */
  audioInitialized: boolean
  setStatus: (s: SceneStatus) => void
  setVrmProgress: (p: number) => void
  setError: (message: string) => void
  setAudioInitialized: () => void
  reset: () => void
}

const INITIAL: Pick<
  SceneState,
  'status' | 'vrmProgress' | 'errorMessage' | 'audioInitialized'
> = {
  status: 'idle',
  vrmProgress: 0,
  errorMessage: null,
  audioInitialized: false,
}

export const useSceneStore = create<SceneState>()((set) => ({
  ...INITIAL,
  setStatus: (s) =>
    set((state) => {
      // Clear the error message when leaving the error state so a successful
      // retry doesn't keep the old banner text hanging around.
      if (state.status === 'error' && s !== 'error') {
        return { status: s, errorMessage: null }
      }
      return { status: s }
    }),
  setVrmProgress: (p) => {
    // Clamp to [0, 1] — three.js' onProgress can briefly report > 1 when
    // total is undefined (we ignore those in the loader) but belt-and-braces.
    const clamped = Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0
    set({ vrmProgress: clamped })
  },
  setError: (message) => set({ status: 'error', errorMessage: message }),
  setAudioInitialized: () => set({ audioInitialized: true }),
  reset: () => set({ ...INITIAL }),
}))
