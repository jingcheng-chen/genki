import type { VRM } from '@pixiv/three-vrm'
import {
  PRESET_EMOTIONS,
  resolveEmotion,
  type EmotionName,
} from './emotion-vocab'

/**
 * Emotion state machine for VRM expressions.
 *
 * VRM 0.x/1.x require these preset expression names:
 *   happy · angry · sad · relaxed · surprised · neutral
 *
 * An `ACT` marker from the LLM triggers a timed blend: the resolved
 * components lerp up over `fadeInMs`, hold at full intensity for `holdMs`,
 * then lerp back to 0 over `fadeOutMs`. One `active` emotion lives at a
 * time (may span multiple channels after blend-recipe resolution). A second
 * `ACT` cross-fades — the previous one decays immediately.
 *
 * Multi-channel support lets us cover the reference companion's wider
 * emotion vocabulary (curiosity, excitement, love, stress, frustration)
 * without new VRM blendshapes. See `emotion-vocab.ts` for the resolver.
 *
 * Does NOT touch the mouth blendshapes (aa/ih/ou/ee/oh) — those are owned
 * by the lip-sync driver so the two systems don't stomp each other.
 */

export interface ExpressionControllerOptions {
  /** Seconds to ramp in to full intensity. @default 0.25 */
  fadeInMs?: number
  /** Seconds to hold at full intensity before decaying. @default 3000 */
  holdMs?: number
  /** Seconds to decay back to 0. @default 0.6 */
  fadeOutMs?: number
}

export function createExpressionController(options: ExpressionControllerOptions = {}) {
  const fadeInMs = options.fadeInMs ?? 250
  const holdMs = options.holdMs ?? 3000
  const fadeOutMs = options.fadeOutMs ?? 600

  interface ActiveEmotion {
    /** Resolved blend — may contain 1 (primary / synonym) or N (recipe)
     *  components. Each component drives one of the 6 VRM preset channels. */
    components: ReadonlyArray<{ name: EmotionName; weight: number }>
    /** Master gain from the LLM's `intensity` field, clamped to [0, 1]. */
    masterIntensity: number
    /** perf.now() at trigger — anchor for the ADSR envelope. */
    startedAt: number
  }

  let active: ActiveEmotion | null = null
  // Smoothed per-channel weights so cross-fades don't snap.
  const smoothed: Record<EmotionName, number> = {
    happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, neutral: 0,
  }

  return {
    /** Apply an ACT marker from the LLM. Unknown emotion names are ignored. */
    trigger(rawName: string, intensity: number) {
      const resolved = resolveEmotion(rawName)
      if (!resolved) return
      active = {
        components: resolved.face,
        masterIntensity: Math.max(0, Math.min(1, intensity)),
        startedAt: performance.now(),
      }
    },

    /** Force-clear back to neutral (used on barge-in / reset). */
    reset() {
      active = null
    },

    /**
     * Called each frame BEFORE vrm.update(delta). Computes the per-channel
     * target weights from the active emotion's ADSR envelope, smooths all
     * preset channels toward their targets, and writes to the expression
     * manager.
     */
    update(vrm: VRM, delta: number) {
      if (!vrm.expressionManager) return

      const targets: Record<EmotionName, number> = {
        happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, neutral: 0,
      }

      if (active) {
        const elapsed = performance.now() - active.startedAt
        let env = 0

        if (elapsed < fadeInMs) {
          env = elapsed / fadeInMs
        } else if (elapsed < fadeInMs + holdMs) {
          env = 1
        } else {
          const decayT = (elapsed - fadeInMs - holdMs) / fadeOutMs
          env = Math.max(0, 1 - decayT)
          if (env <= 0) active = null
        }

        if (active) {
          // Drive each component channel. max() (not +=) guards against
          // duplicate channels leaking in from a mis-authored recipe — the
          // effect is "pick the loudest expression of this channel", which
          // is always what we want.
          for (const c of active.components) {
            const w = c.weight * active.masterIntensity * env
            targets[c.name] = Math.max(targets[c.name], w)
          }
        }
      }

      // Exponential smoothing (half-life ~80ms — quick enough for
      // cross-fades, slow enough to not look jittery).
      const alpha = 1 - Math.exp(-delta / 0.08)
      for (const name of PRESET_EMOTIONS) {
        smoothed[name] += (targets[name] - smoothed[name]) * alpha
        const w = smoothed[name] < 0.005 ? 0 : smoothed[name]
        vrm.expressionManager.setValue(name, w)
      }
    },
  }
}

export type ExpressionController = ReturnType<typeof createExpressionController>

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------
//
// Same module-level pattern as the lip-sync driver: the UI pushes emotion
// events into it, the per-frame render loop inside <Canvas> reads from it.
// One character at a time speaks, so a singleton is the right shape.

let controller: ExpressionController | null = null

export function getExpressionController(): ExpressionController {
  if (!controller) controller = createExpressionController()
  return controller
}
