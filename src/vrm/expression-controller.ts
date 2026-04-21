import type { VRM } from '@pixiv/three-vrm'

/**
 * Emotion state machine for VRM expressions.
 *
 * VRM 0.x/1.x require these preset expression names:
 *   happy · angry · sad · relaxed · surprised · neutral
 *
 * An `ACT` marker from the LLM triggers a timed blend: the target emotion
 * lerps up over `fadeInMs`, holds at full intensity for `holdMs`, then
 * lerps back to 0 over `fadeOutMs`. One emotion active at a time — a
 * second `ACT` cross-fades, the previous one decays immediately.
 *
 * Does NOT touch the mouth blendshapes (aa/ih/ou/ee/oh) — those are owned
 * by the lip-sync driver so the two systems don't stomp each other.
 */

const PRESET_EMOTIONS = [
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'neutral',
] as const

type EmotionName = (typeof PRESET_EMOTIONS)[number]

/** LLM may emit synonyms; normalize to the VRM preset names. */
const SYNONYMS: Record<string, EmotionName> = {
  joy: 'happy',
  excited: 'happy',
  surprise: 'surprised',
  shocked: 'surprised',
  calm: 'relaxed',
  thinking: 'relaxed',
  think: 'relaxed',
  mad: 'angry',
  sorrowful: 'sad',
  upset: 'sad',
}

function normalizeEmotion(raw: string): EmotionName | null {
  const lower = raw.toLowerCase()
  if ((PRESET_EMOTIONS as readonly string[]).includes(lower)) {
    return lower as EmotionName
  }
  return SYNONYMS[lower] ?? null
}

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
    name: EmotionName
    intensity: number
    startedAt: number
  }

  let active: ActiveEmotion | null = null
  // Smoothed per-emotion values, so cross-fades don't snap.
  const smoothed: Record<EmotionName, number> = {
    happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, neutral: 0,
  }

  return {
    /** Apply an ACT marker from the LLM. Unknown emotion names are ignored. */
    trigger(rawName: string, intensity: number) {
      const name = normalizeEmotion(rawName)
      if (!name) return
      active = {
        name,
        intensity: Math.max(0, Math.min(1, intensity)),
        startedAt: performance.now(),
      }
    },

    /** Force-clear back to neutral (used on barge-in / reset). */
    reset() {
      active = null
    },

    /**
     * Called each frame BEFORE vrm.update(delta). Computes the target
     * weight for the active emotion from the ADSR envelope, smooths all
     * preset emotion weights toward their targets, and writes to the
     * expression manager.
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

        if (active) targets[active.name] = active.intensity * env
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
