import {
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  type AnimationAction,
  type AnimationClip,
} from 'three'
import type { VRM } from '@pixiv/three-vrm'
import {
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation'
import type { VRMAnimationEntry } from './presets'

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
//
// Owns the AnimationMixer. Keeps idle running as the base layer at weight 1.0
// unless an overlay (emotion or gesture clip) is active. Overlays crossfade
// in over `crossfade` seconds, hold for their own duration, then crossfade
// back to idle.
//
// Per-frame call: `update(delta)`. That advances the mixer AND checks
// whether the scheduled fade-back to idle has arrived.

const DEFAULT_CROSSFADE = 0.3
const DEFAULT_HOLD_SECONDS = 3.0

interface PreparedEntry {
  entry: VRMAnimationEntry
  clip: AnimationClip
  action: AnimationAction
}

export interface AnimationController {
  /** Returns the list of gesture ids the LLM can invoke via `<|PLAY:…|>`. */
  getGestureIds(): string[]
  /** Returns the list of bound emotion names (that have a paired body clip). */
  getBoundEmotions(): string[]
  /** Play a one-shot gesture. Returns true if the id is known and started. */
  play(id: string): boolean
  /** Trigger the body clip paired with an ACT emotion. No-op if unbound. */
  triggerEmotion(emotion: string): boolean
  /** Cancel current overlay; crossfade immediately back to idle. */
  stop(): void
  /** Per-frame tick. Must run before `vrm.update(delta)`. */
  update(delta: number): void
  /** Dispose mixer + release clip caches. */
  dispose(): void
}

export function createAnimationController(
  vrm: VRM,
  entries: VRMAnimationEntry[],
  animations: VRMAnimation[],
): AnimationController {
  if (entries.length !== animations.length) {
    throw new Error(
      `[animation-controller] entry/animation count mismatch: ${entries.length} vs ${animations.length}`,
    )
  }

  const mixer = new AnimationMixer(vrm.scene)
  const byId = new Map<string, PreparedEntry>()
  const byEmotion = new Map<string, PreparedEntry>()
  const gestureIds: string[] = []

  let idleEntry: PreparedEntry | null = null

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const clip = createVRMAnimationClip(animations[i], vrm)
    const action = mixer.clipAction(clip)
    const prepared: PreparedEntry = { entry, clip, action }

    byId.set(entry.id, prepared)

    if (entry.kind === 'idle') {
      if (idleEntry) throw new Error('[animation-controller] multiple idle entries')
      idleEntry = prepared
      action.setLoop(LoopRepeat, Infinity)
      action.weight = 1
      action.play()
    } else if (entry.kind === 'emotion') {
      action.setLoop(LoopRepeat, Infinity)
      if (entry.emotion) byEmotion.set(entry.emotion, prepared)
    } else if (entry.kind === 'gesture') {
      action.setLoop(LoopOnce, 1)
      action.clampWhenFinished = true
      gestureIds.push(entry.id)
    }
  }

  if (!idleEntry) throw new Error('[animation-controller] no idle entry declared')

  // Current overlay state — what's on top of idle right now.
  let overlay: PreparedEntry | null = null
  let elapsed = 0
  let fadeBackAt: number | null = null

  const crossfadeOf = (e: VRMAnimationEntry) => e.crossfade ?? DEFAULT_CROSSFADE
  const holdOf = (e: VRMAnimationEntry) =>
    (e.holdSeconds ?? DEFAULT_HOLD_SECONDS) * 1000

  function startOverlay(next: PreparedEntry) {
    const fade = crossfadeOf(next.entry)

    // Restart if the same overlay is already playing.
    if (overlay?.entry.id === next.entry.id) {
      next.action.reset()
      next.action.play()
      fadeBackAt = computeFadeBack(next)
      return
    }

    const previous = overlay?.action ?? idleEntry!.action

    next.action.reset()
    next.action.enabled = true
    next.action.setEffectiveWeight(1)
    next.action.play()
    // crossFadeFrom: lerp `previous` weight → 0 and `next` weight → 1 over
    // `fade` seconds. `true` = warp time scales so they stay in phase (safer
    // even though most of our clips aren't synced).
    next.action.crossFadeFrom(previous, fade, true)

    overlay = next
    fadeBackAt = computeFadeBack(next)
  }

  function computeFadeBack(p: PreparedEntry): number | null {
    const fade = crossfadeOf(p.entry) * 1000
    if (p.entry.kind === 'gesture') {
      // Clip duration in ms, minus the crossfade window so we start the
      // fade-back at the right moment — landing on idle exactly as the
      // clip reaches its final frame.
      const clipMs = p.clip.duration * 1000
      return elapsed + Math.max(0, clipMs - fade)
    }
    if (p.entry.kind === 'emotion') {
      return elapsed + holdOf(p.entry)
    }
    return null
  }

  function returnToIdle() {
    if (!overlay) return
    const fade = crossfadeOf(overlay.entry)
    const idle = idleEntry!.action
    idle.reset()
    idle.enabled = true
    idle.setEffectiveWeight(1)
    idle.play()
    idle.crossFadeFrom(overlay.action, fade, true)
    overlay = null
    fadeBackAt = null
  }

  return {
    getGestureIds: () => [...gestureIds],

    getBoundEmotions: () => [...byEmotion.keys()],

    play(id) {
      const p = byId.get(id)
      if (!p || p.entry.kind !== 'gesture') return false
      startOverlay(p)
      return true
    },

    triggerEmotion(emotion) {
      const p = byEmotion.get(emotion)
      if (!p) return false
      startOverlay(p)
      return true
    },

    stop() {
      returnToIdle()
    },

    update(delta) {
      elapsed += delta * 1000
      mixer.update(delta)
      if (fadeBackAt !== null && elapsed >= fadeBackAt) {
        returnToIdle()
      }
    },

    dispose() {
      mixer.stopAllAction()
      for (const { clip } of byId.values()) mixer.uncacheClip(clip)
      mixer.uncacheRoot(vrm.scene)
    },
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------
//
// Same pattern as the lip-sync + expression controllers. VRMCharacter
// constructs one on mount and publishes it here; the turn pipeline, markers
// parser, and debug tools read from it via the getter.

let active: AnimationController | null = null

export function setActiveAnimationController(c: AnimationController | null) {
  active = c
}

export function getActiveAnimationController(): AnimationController | null {
  return active
}
