import { tracer, TRACER_ACTIVE } from './tracer'

/**
 * Phase 8 — FPS sampler.
 *
 * Plugged into R3F's `useFrame` loop. Called every frame, but only
 * emits a `fps` trace event once per second (tunable via `intervalMs`).
 * Avoids polluting the trace ring with hundreds of per-frame entries.
 *
 * Use when:
 * - Inside a `useFrame` callback, right after the rest of the
 *   per-frame work so our timing reflects the full stack cost.
 *
 * Expects:
 * - Called at the render rate; internally decides whether to emit.
 *
 * Returns:
 * - void. Fire-and-forget; emits to `tracer` directly.
 *
 * @example
 *   useFrame((_, delta) => {
 *     fpsSampler(delta)
 *   })
 */
export interface FpsSampler {
  (delta: number): void
}

/**
 * Creates a per-component FPS sampler. Keep its state (frame count,
 * last-emit timestamp) in a closure — we don't want two VRM instances
 * double-counting.
 */
export function createFpsSampler(intervalMs = 1000): FpsSampler {
  let frames = 0
  let accum = 0
  let lastEmit = performance.now()

  return function sample(delta: number) {
    // Zero-cost in production — the tracer singleton is a no-op, but
    // bail out even earlier so we don't spend frame budget on counting.
    if (!TRACER_ACTIVE) return

    frames += 1
    accum += delta

    const now = performance.now()
    const elapsed = now - lastEmit
    if (elapsed >= intervalMs) {
      // Fresh FPS measurement: frames/elapsed gives the actual observed
      // rate in this window, independent of any vsync drift.
      const fps = frames / (elapsed / 1000)
      const frameMs = accum === 0 ? 0 : (accum * 1000) / frames

      tracer.emit({
        category: 'fps',
        data: { fps: Number(fps.toFixed(1)), frameMs: Number(frameMs.toFixed(2)) },
      })

      frames = 0
      accum = 0
      lastEmit = now
    }
  }
}
