import { beforeEach, describe, it, expect } from 'vitest'
import { useSceneStore } from '../scene'

/**
 * Phase 10 — scene store reducer tests.
 *
 * @example
 *   expect(useSceneStore.getState().status).toBe('idle')
 */
describe('useSceneStore', () => {
  beforeEach(() => {
    useSceneStore.getState().reset()
  })

  it('starts in the idle state with zero progress and no error', () => {
    const s = useSceneStore.getState()
    expect(s.status).toBe('idle')
    expect(s.vrmProgress).toBe(0)
    expect(s.errorMessage).toBeNull()
  })

  it('setStatus writes the status through', () => {
    useSceneStore.getState().setStatus('loading-vrm')
    expect(useSceneStore.getState().status).toBe('loading-vrm')

    useSceneStore.getState().setStatus('binding')
    expect(useSceneStore.getState().status).toBe('binding')

    useSceneStore.getState().setStatus('ready')
    expect(useSceneStore.getState().status).toBe('ready')
  })

  it('progresses through the happy path without losing state', () => {
    const store = useSceneStore.getState()
    const seq = [
      'rehydrating',
      'loading-vrm',
      'binding',
      'audio-initializing',
      'ready',
    ] as const
    for (const s of seq) {
      store.setStatus(s)
      expect(useSceneStore.getState().status).toBe(s)
    }
  })

  it('clamps vrmProgress to [0, 1]', () => {
    useSceneStore.getState().setVrmProgress(-0.2)
    expect(useSceneStore.getState().vrmProgress).toBe(0)

    useSceneStore.getState().setVrmProgress(0.5)
    expect(useSceneStore.getState().vrmProgress).toBe(0.5)

    useSceneStore.getState().setVrmProgress(1.7)
    expect(useSceneStore.getState().vrmProgress).toBe(1)
  })

  it('treats NaN / Infinity progress as 0 rather than crashing', () => {
    useSceneStore.getState().setVrmProgress(Number.NaN)
    expect(useSceneStore.getState().vrmProgress).toBe(0)

    // Infinity is non-finite so we floor it at 0 rather than 1 — keeps
    // the bar from jumping to full on a flaky/malformed progress event.
    useSceneStore.getState().setVrmProgress(Number.POSITIVE_INFINITY)
    expect(useSceneStore.getState().vrmProgress).toBe(0)

    useSceneStore.getState().setVrmProgress(Number.NEGATIVE_INFINITY)
    expect(useSceneStore.getState().vrmProgress).toBe(0)
  })

  it('setError sets the status to error and stores the message', () => {
    useSceneStore.getState().setError('Network timeout fetching model.vrm')
    const s = useSceneStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorMessage).toBe('Network timeout fetching model.vrm')
  })

  it('clears the error message when leaving the error state', () => {
    useSceneStore.getState().setError('boom')
    expect(useSceneStore.getState().errorMessage).toBe('boom')

    useSceneStore.getState().setStatus('loading-vrm')
    const s = useSceneStore.getState()
    expect(s.status).toBe('loading-vrm')
    expect(s.errorMessage).toBeNull()
  })

  it('keeps errorMessage when setStatus is called with error again', () => {
    useSceneStore.getState().setError('first')
    useSceneStore.getState().setStatus('error')
    const s = useSceneStore.getState()
    expect(s.status).toBe('error')
    expect(s.errorMessage).toBe('first')
  })

  it('reset returns to initial state and clears progress + error', () => {
    useSceneStore.getState().setStatus('loading-vrm')
    useSceneStore.getState().setVrmProgress(0.8)
    useSceneStore.getState().setError('boom')

    useSceneStore.getState().reset()
    const s = useSceneStore.getState()
    expect(s.status).toBe('idle')
    expect(s.vrmProgress).toBe(0)
    expect(s.errorMessage).toBeNull()
  })

  it('allows teleport transitions (no guard rails) — caller is responsible for ordering', () => {
    // The store is a plain state holder; it does not enforce the
    // FSM shape. Documented here so future contributors know where the
    // validation lives (the StartGate / VRMCharacter callers).
    useSceneStore.getState().setStatus('ready')
    useSceneStore.getState().setStatus('idle')
    expect(useSceneStore.getState().status).toBe('idle')
  })
})
