import type { VRMAnimationEntry } from './types';

/**
 * Shared animation roster across every character preset.
 *
 * Every character under `/public/vrm/<preset>/animations/` ships the same
 * 22-clip set (authored once, copied per character). Rather than repeat the
 * per-preset animation list in three places, this factory builds a
 * preset-scoped list from a single source of truth.
 *
 * Filename is stored separately from the canonical `id` because the disk
 * filename doesn't always match the short gesture name we advertise to the
 * LLM:
 *   - `peeking.vrma`         → id `peek`
 *   - `spinning.vrma`        → id `spin`
 *   - `looking_around.vrma`  → id `look_around`
 *   - `dancing.vrma`         → id `dance`
 *
 * The canonical id is what goes into the system prompt's gesture list and
 * the LLM's `<|PLAY:…|>` markers, so short + stable wins.
 */

export interface AnimationTemplate {
  id: string;
  filename: string;
  kind: VRMAnimationEntry['kind'];
  emotion?: VRMAnimationEntry['emotion'];
}

// Number of extra idle clips that live on disk for every preset as
// `/public/vrm/<preset>/animations/idle_<N>.vrm`. The canonical idle
// (`idle.vrma`) stays as the "default" and joins the random rotation
// alongside these. Extension is `.vrm` because that's what the user
// dropped into the folder — the VRM animation loader keys off the
// glTF extension `VRMC_vrm_animation`, not the filename suffix.
const IDLE_VARIANT_COUNT = 20;

const IDLE_VARIANT_TEMPLATES: AnimationTemplate[] = Array.from({ length: IDLE_VARIANT_COUNT }, (_, i) => {
  const n = i + 1;
  return {
    id: `idle_${n}`,
    filename: `idle_${n}.vrma`,
    kind: 'idle_variant',
  };
});

export const STANDARD_ANIMATION_TEMPLATES: readonly AnimationTemplate[] = [
  { id: 'idle', filename: 'idle.vrma', kind: 'idle' },
  ...IDLE_VARIANT_TEMPLATES,

  // Emotion clips — `blush` is the warmest of the set; bound to `happy`
  // so an <|ACT:happy|> from the LLM fires the body pose too.
  { id: 'blush', filename: 'blush.vrma', kind: 'emotion', emotion: 'happy' },
  { id: 'sad', filename: 'sad.vrma', kind: 'emotion', emotion: 'sad' },
  { id: 'angry', filename: 'angry.vrma', kind: 'emotion', emotion: 'angry' },
  { id: 'surprised', filename: 'surprised.vrma', kind: 'emotion', emotion: 'surprised' },
  { id: 'relax', filename: 'relax.vrma', kind: 'emotion', emotion: 'relaxed' },

  // Universal gestures.
  { id: 'clapping', filename: 'clapping.vrma', kind: 'gesture' },
  { id: 'goodbye', filename: 'goodbye.vrma', kind: 'gesture' },
  { id: 'thinking', filename: 'thinking.vrma', kind: 'gesture' },
  { id: 'sleepy', filename: 'sleepy.vrma', kind: 'gesture' },
  { id: 'look_around', filename: 'looking_around.vrma', kind: 'gesture' },
  { id: 'dance', filename: 'dancing.vrma', kind: 'gesture' },

  // Gestures the reference companion exposes as explicit avatar actions
  // (see `ani.reference.analysis.md`). Available on all presets now.
  { id: 'peek', filename: 'peeking.vrma', kind: 'gesture' },
  { id: 'spin', filename: 'spinning.vrma', kind: 'gesture' },

  // Available-but-rare. Most characters won't argue or yell by default,
  // but the LLM might reach for them in the right context.
  { id: 'arguing', filename: 'arguing.vrma', kind: 'gesture' },
  { id: 'yelling', filename: 'yelling.vrma', kind: 'gesture' },

  // `kissing` is registered here by default. Character files that want to
  // block it (e.g. Shiro, a sixteen-year-old SFW character) pass
  // `{ exclude: ['kissing'] }` to the factory — defence in depth on top
  // of the persona-level prohibition.
  { id: 'kissing', filename: 'kissing.vrma', kind: 'gesture' },

  // Speaking-idle variants. `kind: 'talking'` is invisible to the LLM —
  // these never appear in the advertised gesture list. The animation
  // controller chains them randomly while the turn controller is in the
  // 'speaking' state (see `animation-controller.ts`, `startSpeaking`).
  { id: 'talking_1', filename: 'talking_1.vrma', kind: 'talking' },
  { id: 'talking_2', filename: 'talking_2.vrma', kind: 'talking' },
  { id: 'talking_3', filename: 'talking_3.vrma', kind: 'talking' },
  { id: 'talking_4', filename: 'talking_4.vrma', kind: 'talking' },
  { id: 'talking_5', filename: 'talking_5.vrma', kind: 'talking' },
];

export interface MakeAnimationsOptions {
  /**
   * Gesture ids to omit from this preset's animation list. Use to keep a
   * clip on disk (for future use) while making it unavailable to the LLM
   * today. The gesture name never appears in the system prompt for
   * excluded ids — the LLM can't reach for what it doesn't know about.
   */
  exclude?: readonly string[];
}

export function makeStandardAnimations(presetId: string, opts: MakeAnimationsOptions = {}): VRMAnimationEntry[] {
  const exclude = new Set(opts.exclude ?? []);
  return STANDARD_ANIMATION_TEMPLATES.filter((t) => !exclude.has(t.id)).map((t) => ({
    id: t.id,
    url: `/vrm/${presetId}/animations/${t.filename}`,
    kind: t.kind,
    ...(t.emotion ? { emotion: t.emotion } : {}),
  }));
}
