import { Object3D, Vector3, type Camera } from 'three'
import type { VRM } from '@pixiv/three-vrm'

// ---------------------------------------------------------------------------
// Blink controller
// ---------------------------------------------------------------------------

export interface BlinkOptions {
  /** Minimum seconds between blinks. @default 3 */
  minInterval?: number
  /** Maximum seconds between blinks. @default 6 */
  maxInterval?: number
  /** Seconds for eyelids to close. @default 0.08 */
  closeDuration?: number
  /** Seconds eyelids stay fully closed. @default 0.05 */
  holdDuration?: number
  /** Seconds for eyelids to open. @default 0.12 */
  openDuration?: number
}

/**
 * Creates a blink controller that jitters interval + phase durations each cycle.
 *
 * Use when:
 * - You want a VRM to blink periodically with human-like irregularity
 *
 * Expects:
 * - vrm.expressionManager supports the 'blink' preset (VRM spec requires it)
 * - update(vrm, delta) is called each frame BEFORE vrm.update(delta), so the
 *   committed expression weight is the one we just set
 *
 * Returns:
 * - update(vrm, delta) — mutates vrm.expressionManager
 */
export function createBlinkController(options: BlinkOptions = {}) {
  const opts = {
    minInterval: options.minInterval ?? 3,
    maxInterval: options.maxInterval ?? 6,
    closeDuration: options.closeDuration ?? 0.08,
    holdDuration: options.holdDuration ?? 0.05,
    openDuration: options.openDuration ?? 0.12,
  }

  let phase: 'idle' | 'closing' | 'holding' | 'opening' = 'idle'
  let elapsed = 0
  let phaseStart = 0
  let scheduledAt = 0

  const scheduleNext = () => {
    scheduledAt =
      elapsed +
      opts.minInterval +
      Math.random() * (opts.maxInterval - opts.minInterval)
    phase = 'idle'
  }
  scheduleNext()

  return function update(vrm: VRM, delta: number) {
    elapsed += delta

    if (phase === 'idle' && elapsed >= scheduledAt) {
      phase = 'closing'
      phaseStart = elapsed
    }

    let value = 0

    if (phase === 'closing') {
      const progress = (elapsed - phaseStart) / opts.closeDuration
      value = Math.min(1, progress)
      if (progress >= 1) {
        phase = 'holding'
        phaseStart = elapsed
      }
    } else if (phase === 'holding') {
      value = 1
      if (elapsed - phaseStart >= opts.holdDuration) {
        phase = 'opening'
        phaseStart = elapsed
      }
    } else if (phase === 'opening') {
      const progress = (elapsed - phaseStart) / opts.openDuration
      value = Math.max(0, 1 - progress)
      if (progress >= 1) scheduleNext()
    }

    vrm.expressionManager?.setValue('blink', value)
  }
}

// ---------------------------------------------------------------------------
// Saccade / lookAt controller
// ---------------------------------------------------------------------------

export interface SaccadeOptions {
  /** Minimum seconds between gaze shifts. @default 1.2 */
  minInterval?: number
  /** Maximum seconds between gaze shifts. @default 3.0 */
  maxInterval?: number
  /** Horizontal drift range in metres. @default 0.18 */
  driftX?: number
  /** Vertical drift range in metres. @default 0.1 */
  driftY?: number
  /** Smoothing rate — higher snaps faster to the new fixation. @default 2.2 */
  smoothing?: number
}

/**
 * Creates a saccade controller: the VRM looks at the camera with small
 * human-like gaze drifts, re-targeting every 1-3 seconds.
 *
 * Use when:
 * - The character should feel "present" and eye-contact-aware without being
 *   robotically locked onto the camera
 *
 * Expects:
 * - vrm.lookAt is defined (true for all well-authored VRMs)
 * - update(vrm, camera, delta) runs each frame BEFORE vrm.update(delta);
 *   vrm.update calls lookAt.update which reads target.getWorldPosition
 *
 * Returns:
 * - target — the Object3D the VRM tracks. Add to the scene once.
 * - update(vrm, camera, delta)
 * - dispose — detach from parent
 */
export function createSaccadeController(options: SaccadeOptions = {}) {
  const opts = {
    minInterval: options.minInterval ?? 1.2,
    maxInterval: options.maxInterval ?? 3.0,
    driftX: options.driftX ?? 0.18,
    driftY: options.driftY ?? 0.1,
    smoothing: options.smoothing ?? 2.2,
  }

  const target = new Object3D()
  target.name = 'saccade-lookAt-target'

  const drift = new Vector3()
  const driftTarget = new Vector3()
  const cameraWorld = new Vector3()

  let elapsed = 0
  let nextDriftAt = 0
  let bound = false

  const pickNewDrift = () => {
    driftTarget.set(
      (Math.random() * 2 - 1) * opts.driftX,
      (Math.random() * 2 - 1) * opts.driftY,
      0,
    )
    nextDriftAt =
      elapsed +
      opts.minInterval +
      Math.random() * (opts.maxInterval - opts.minInterval)
  }
  pickNewDrift()

  return {
    target,
    update(vrm: VRM, camera: Camera, delta: number) {
      elapsed += delta

      if (elapsed >= nextDriftAt) pickNewDrift()

      // Exponential smoothing: lerp drift → driftTarget with a half-life
      // determined by `smoothing`.
      const t = 1 - Math.exp(-opts.smoothing * delta)
      drift.lerp(driftTarget, t)

      // Target world position = camera position + drift offset in camera-local X/Y.
      camera.getWorldPosition(cameraWorld)
      target.position.set(
        cameraWorld.x + drift.x,
        cameraWorld.y + drift.y,
        cameraWorld.z,
      )
      target.updateMatrixWorld()

      if (vrm.lookAt && !bound) {
        vrm.lookAt.target = target
        bound = true
      }
    },
    dispose() {
      target.removeFromParent()
    },
  }
}
