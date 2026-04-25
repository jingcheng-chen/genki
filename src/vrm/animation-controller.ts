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
// Owns the AnimationMixer. Maintains a *base layer* — the idle clip by
// default, or one of the 'talking' clips while the turn controller has us
// in the 'speaking' state. Overlays (emotion / gesture) cross-fade in over
// the base, hold for their own duration, then cross-fade back to whatever
// the base happens to be at that moment.
//
// The talking layer is a chain of finite clips, not a single looping clip:
// each talking clip is LoopOnce; on 'finished' the controller picks the
// next variant at random (excluding the one we just played) and cross-
// fades into it. Speaking ends → cross-fade back to idle, mid-clip if
// necessary. See `startSpeaking` / `stopSpeaking` / `chainTalking`.
//
// Per-frame call: `update(delta)`. That advances the mixer AND checks
// whether the scheduled fade-back from an overlay has arrived.

const DEFAULT_CROSSFADE = 0.3
const DEFAULT_HOLD_SECONDS = 3.0

// Crossfade durations specific to the talking base layer.
// - idle → talking: a beat-in as speech starts.
// - talking → talking: quick pivot within speech.
// - talking → idle:  a settle after speech. Longer than the others because
//   we're blending from active arm motion to arms-at-sides — a fast fade
//   reads as the arms "dropping" instead of settling.
const TALKING_FADE_IN = 0.5
const TALKING_FADE_CHAIN = 0.3
const TALKING_FADE_OUT = 0.7

// Used when an overlay (gesture / emotion body clip) ends and we need to
// return to the talking base. Active-motion-to-active-motion transitions
// need more overlap than the default gesture-to-idle return, otherwise the
// handover snaps instead of blending.
const OVERLAY_RETURN_TO_TALKING_FADE = 0.6

// Idle chain crossfades. Idle-variant clips are similar in energy (no big
// arm swings), so we can get away with slightly shorter blends than
// talking. Still longer than DEFAULT_CROSSFADE because two different idle
// clips can have different hip sway and a fast blend reads as a "jerk".
const IDLE_FADE_CHAIN = 0.6

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
  /** Cancel current overlay; crossfade immediately back to the current base. */
  stop(): void
  /**
   * Begin the talking chain: pick a random 'talking' clip as the base
   * layer, and keep chaining new picks every time the current clip
   * finishes. No-op if the preset has no 'talking' entries, or if already
   * speaking. Safe to call repeatedly.
   */
  startSpeaking(): void
  /**
   * End the talking chain: crossfade whatever talking clip is currently
   * base (even if mid-play) back to the idle clip. Safe to call if not
   * currently speaking.
   */
  stopSpeaking(): void
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
  const talkingEntries: PreparedEntry[] = []
  const idleEntries: PreparedEntry[] = []

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
      idleEntries.push(prepared)
      // Loop mode decided below once we know whether variants exist.
    } else if (entry.kind === 'idle_variant') {
      idleEntries.push(prepared)
      // Loop mode decided below.
    } else if (entry.kind === 'emotion') {
      action.setLoop(LoopRepeat, Infinity)
      if (entry.emotion) byEmotion.set(entry.emotion, prepared)
    } else if (entry.kind === 'gesture') {
      action.setLoop(LoopOnce, 1)
      action.clampWhenFinished = true
      gestureIds.push(entry.id)
    } else if (entry.kind === 'talking') {
      // Prepared lazily — not played until startSpeaking(). LoopOnce so
      // the 'finished' event fires and the chain picks up the next one.
      action.setLoop(LoopOnce, 1)
      action.clampWhenFinished = true
      talkingEntries.push(prepared)
    }
  }

  if (!idleEntry) throw new Error('[animation-controller] no idle entry declared')

  // Idle setup:
  //   - Single idle (no variants): keep legacy behaviour — LoopRepeat
  //     forever, the idle clip is the permanent base layer.
  //   - Multiple (default + variants): LoopOnce + clampWhenFinished on
  //     every idle. The 'finished' handler chains into a fresh random
  //     pick via chainIdle(). The default idle is the starting clip.
  const hasIdleChain = idleEntries.length > 1
  if (hasIdleChain) {
    for (const { action } of idleEntries) {
      action.setLoop(LoopOnce, 1)
      action.clampWhenFinished = true
    }
    idleEntry.action.weight = 1
    idleEntry.action.play()
  } else {
    idleEntry.action.setLoop(LoopRepeat, Infinity)
    idleEntry.action.weight = 1
    idleEntry.action.play()
  }

  // Current overlay state — what's on top of the base right now.
  let overlay: PreparedEntry | null = null
  let elapsed = 0
  let fadeBackAt: number | null = null

  // Talking base state. While speaking, the "base" conceptually shifts from
  // idle to one of these clips — driven by `currentTalkingEntry`. When
  // `currentTalkingEntry === null` the base is the idle chain (or the
  // single idle clip if no variants exist).
  let speakingActive = false
  let currentTalkingEntry: PreparedEntry | null = null
  let lastTalkingId: string | null = null
  // Set by the mixer 'finished' handler when a talking clip finishes while
  // an overlay is covering it. We can't chain mid-overlay (would blend two
  // weight-1 actions over the overlay), so we wait until the overlay ends
  // and pick a fresh talking clip then — see returnToBase().
  let talkingFinishedDuringOverlay = false

  // Idle chain state. When `hasIdleChain` is true, the base is whichever
  // idle clip is currently playing — starts as the default, then rotates
  // through variants as each clip finishes. Single-idle presets keep
  // `currentIdleEntry === idleEntry` forever.
  let currentIdleEntry: PreparedEntry = idleEntry
  let lastIdleId: string | null = hasIdleChain ? idleEntry.entry.id : null
  // Mirror of talkingFinishedDuringOverlay for the idle chain.
  let idleFinishedDuringOverlay = false

  const crossfadeOf = (e: VRMAnimationEntry) => e.crossfade ?? DEFAULT_CROSSFADE
  const holdOf = (e: VRMAnimationEntry) =>
    (e.holdSeconds ?? DEFAULT_HOLD_SECONDS) * 1000

  /** The action the overlay would fade back to right now. */
  function getCurrentBaseAction(): AnimationAction {
    return currentTalkingEntry?.action ?? currentIdleEntry.action
  }

  function startOverlay(next: PreparedEntry) {
    const fade = crossfadeOf(next.entry)

    // Restart if the same overlay is already playing.
    if (overlay?.entry.id === next.entry.id) {
      next.action.reset()
      next.action.play()
      fadeBackAt = computeFadeBack(next)
      return
    }

    // Crossfade from either the in-flight overlay or the current base.
    const previous = overlay?.action ?? getCurrentBaseAction()

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
      // fade-back at the right moment — landing on the base exactly as the
      // clip reaches its final frame.
      const clipMs = p.clip.duration * 1000
      return elapsed + Math.max(0, clipMs - fade)
    }
    if (p.entry.kind === 'emotion') {
      return elapsed + holdOf(p.entry)
    }
    return null
  }

  function returnToBase() {
    if (!overlay) return

    // Pick the target action and the fade duration.
    //
    // Three cases:
    //   (a) speaking + talking clip finished during the overlay → pick a
    //       fresh talking clip and prepare it as the new base. Fade is
    //       long (active-to-active needs overlap).
    //   (b) speaking, current talking clip is still running → fade back
    //       to the current talking clip. Same long fade.
    //   (c) not speaking → fade back to idle. Short fade is fine (the
    //       base pose is still; no risk of the arms "dropping" hard).
    let targetAction: AnimationAction
    let fade: number

    if (speakingActive && talkingFinishedDuringOverlay) {
      // (a)
      talkingFinishedDuringOverlay = false
      const chosen = pickRandomTalking()
      targetAction = chosen.action
      targetAction.reset()
      targetAction.setLoop(LoopOnce, 1)
      targetAction.clampWhenFinished = true
      targetAction.enabled = true
      targetAction.play()
      currentTalkingEntry = chosen
      lastTalkingId = chosen.entry.id
      fade = OVERLAY_RETURN_TO_TALKING_FADE
    } else if (speakingActive && currentTalkingEntry) {
      // (b)
      targetAction = currentTalkingEntry.action
      targetAction.enabled = true
      targetAction.play()
      fade = OVERLAY_RETURN_TO_TALKING_FADE
    } else if (hasIdleChain && idleFinishedDuringOverlay) {
      // (c1) not speaking, the idle clip finished under the overlay.
      // Pick a fresh idle variant and start it — same pattern as (a).
      idleFinishedDuringOverlay = false
      const chosen = pickRandomIdle()
      targetAction = chosen.action
      targetAction.reset()
      targetAction.setLoop(LoopOnce, 1)
      targetAction.clampWhenFinished = true
      targetAction.enabled = true
      targetAction.play()
      currentIdleEntry = chosen
      lastIdleId = chosen.entry.id
      fade = IDLE_FADE_CHAIN
    } else {
      // (c2) not speaking, resume the idle that was playing when the
      // overlay started. Single-idle presets hit this branch as well.
      targetAction = currentIdleEntry.action
      targetAction.enabled = true
      targetAction.play()
      fade = crossfadeOf(overlay.entry)
    }

    // Do the actual crossfade. crossFadeFrom handles weight interpolation;
    // explicit setEffectiveWeight is unnecessary and can fight the schedule.
    targetAction.crossFadeFrom(overlay.action, fade, true)

    overlay = null
    fadeBackAt = null
  }

  // -------------------------------------------------------------------------
  // Idle chain
  // -------------------------------------------------------------------------

  function pickRandomIdle(): PreparedEntry {
    // Exclude the last-played id so the same clip never fires twice in a
    // row. Falls back to the full pool for single-entry presets (though
    // in practice the chain is only active when idleEntries.length > 1).
    const candidates = idleEntries.filter((e) => e.entry.id !== lastIdleId)
    const pool = candidates.length > 0 ? candidates : idleEntries
    return pool[Math.floor(Math.random() * pool.length)]
  }

  function chainIdle() {
    // Precondition: hasIdleChain, !speakingActive, !overlay.
    if (!hasIdleChain) return
    const prev = currentIdleEntry
    const next = pickRandomIdle()
    next.action.reset()
    next.action.setLoop(LoopOnce, 1)
    next.action.clampWhenFinished = true
    next.action.enabled = true
    next.action.setEffectiveWeight(1)
    next.action.play()
    next.action.crossFadeFrom(prev.action, IDLE_FADE_CHAIN, true)
    currentIdleEntry = next
    lastIdleId = next.entry.id
  }

  // -------------------------------------------------------------------------
  // Talking chain
  // -------------------------------------------------------------------------

  function pickRandomTalking(): PreparedEntry {
    // Exclude the last-played id so repeats are rare. Falls back to the full
    // pool if the exclusion would leave it empty (single-clip presets).
    const candidates = talkingEntries.filter((e) => e.entry.id !== lastTalkingId)
    const pool = candidates.length > 0 ? candidates : talkingEntries
    return pool[Math.floor(Math.random() * pool.length)]
  }

  function engageTalkingClip(
    chosen: PreparedEntry,
    opts: { fromAction: AnimationAction; fade: number },
  ) {
    const next = chosen.action
    next.reset()
    next.setLoop(LoopOnce, 1)
    next.clampWhenFinished = true
    next.enabled = true

    if (overlay) {
      // Silent swap: overlay is the foreground. Start the new base playing
      // at weight 0 so its internal clock advances in the background. When
      // the overlay ends, returnToBase() will crossfade the overlay into it.
      next.setEffectiveWeight(0)
      next.play()
    } else {
      next.setEffectiveWeight(1)
      next.play()
      next.crossFadeFrom(opts.fromAction, opts.fade, true)
    }

    currentTalkingEntry = chosen
    lastTalkingId = chosen.entry.id
  }

  function chainTalking() {
    // Precondition: speakingActive === true, currentTalkingEntry !== null,
    // no overlay is active. Pick a new clip, crossfade from the one that
    // just finished.
    const prev = currentTalkingEntry
    if (!prev) return
    engageTalkingClip(pickRandomTalking(), {
      fromAction: prev.action,
      fade: TALKING_FADE_CHAIN,
    })
  }

  // Global 'finished' listener on the mixer. Fires for every LoopOnce
  // action that completes — we filter to just the clip currently acting
  // as the base layer (talking variant while speaking, idle variant when
  // not). Gestures and emotion bodies also fire 'finished', but we let
  // the overlay's scheduled `fadeBackAt` drive their handoff rather than
  // reacting here; if we crossfaded inside this handler, the overlay and
  // the base would briefly fight for weight.
  mixer.addEventListener('finished', (e: { action: AnimationAction }) => {
    if (speakingActive && currentTalkingEntry && e.action === currentTalkingEntry.action) {
      if (overlay) {
        // Can't chain with an overlay in the way — defer until it ends.
        talkingFinishedDuringOverlay = true
      } else {
        chainTalking()
      }
      return
    }
    if (!speakingActive && hasIdleChain && e.action === currentIdleEntry.action) {
      if (overlay) {
        idleFinishedDuringOverlay = true
      } else {
        chainIdle()
      }
    }
  })

  function startSpeaking() {
    if (speakingActive) return
    speakingActive = true
    // Reset any pending idle-chain tick — we're about to blow past the
    // idle layer with a talking clip. The current idle clip is left
    // paused-in-place; `finished` events for it no longer chain because
    // `speakingActive === true` gates the idle branch of the handler.
    idleFinishedDuringOverlay = false
    if (talkingEntries.length === 0) return
    // Engage the first talking clip. If an overlay is currently active
    // the engagement is silent; otherwise we visibly crossfade from the
    // current idle (default or variant).
    engageTalkingClip(pickRandomTalking(), {
      fromAction: currentIdleEntry.action,
      fade: TALKING_FADE_IN,
    })
  }

  function stopSpeaking() {
    if (!speakingActive) return
    speakingActive = false
    talkingFinishedDuringOverlay = false
    const prev = currentTalkingEntry
    currentTalkingEntry = null
    if (!prev) return

    // Pick a fresh idle to land on — so the post-speech pose varies
    // instead of always snapping back to the same default clip. For
    // single-idle presets this returns `idleEntry` unchanged.
    const chosen = hasIdleChain ? pickRandomIdle() : idleEntry!
    const idleAction = chosen.action
    idleAction.reset()
    if (hasIdleChain) {
      idleAction.setLoop(LoopOnce, 1)
      idleAction.clampWhenFinished = true
    }
    idleAction.enabled = true
    currentIdleEntry = chosen
    lastIdleId = chosen.entry.id

    if (overlay) {
      // Silent — overlay is foreground. Prep idle at weight 0 so when
      // the overlay ends returnToBase() crossfades into it. Make sure
      // the now-stale talking clip isn't contributing weight behind the
      // overlay (it was at 0 already, but be explicit).
      idleAction.setEffectiveWeight(0)
      idleAction.play()
      prev.action.setEffectiveWeight(0)
    } else {
      idleAction.setEffectiveWeight(1)
      idleAction.play()
      idleAction.crossFadeFrom(prev.action, TALKING_FADE_OUT, true)
    }
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
      returnToBase()
    },

    startSpeaking,

    stopSpeaking,

    update(delta) {
      elapsed += delta * 1000
      mixer.update(delta)
      if (fadeBackAt !== null && elapsed >= fadeBackAt) {
        returnToBase()
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
