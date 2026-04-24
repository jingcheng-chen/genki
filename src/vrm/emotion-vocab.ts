/**
 * Extended emotion vocabulary + resolver.
 *
 * VRM presets give us a 6-channel expression basis:
 *   happy · angry · sad · relaxed · surprised · neutral
 *
 * The grok/xAI reference companion (`ani.reference.yml`) exposes a richer
 * feeling-space — curiosity, shyness, excitement, love, stress, frustration,
 * sadness — driven by a dedicated `showEmotion` tool. We project those onto
 * our 6 primaries, either as an alias (shyness → happy) or as a multi-
 * channel blend recipe (excitement = happy 0.75 + surprised 0.55).
 *
 * Each incoming name resolves to:
 *   - `face`    : array of (channel, weight) pairs for the expression
 *                 controller to drive simultaneously.
 *   - `primary` : the dominant channel — used to look up a paired body clip
 *                 on the active preset. An `excitement` marker on Mika
 *                 therefore fires her `blush` body clip (bound to `happy`),
 *                 even though the face is a two-channel blend.
 *
 * Weights above 1 are fine: three-vrm clamps per-blendshape downstream, and
 * our controller applies a master intensity + envelope on top. This module
 * is a pure lookup table; all timing lives in the controller.
 *
 * NOTICE: the canonical list lives in `ALLOWED_EMOTION_NAMES`. Both the
 * system-prompt builder (to advertise the vocabulary to the model) and the
 * tests (to pin cache-floor behaviour) read from it — don't hard-code the
 * list in more than one place.
 */

export const PRESET_EMOTIONS = [
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'neutral',
] as const

export type EmotionName = (typeof PRESET_EMOTIONS)[number]

export interface EmotionComponents {
  /** One or more preset channels to drive. */
  face: Array<{ name: EmotionName; weight: number }>
  /** Dominant channel — used by the animation controller to find a paired
   *  body clip. For single-channel aliases this equals `face[0].name`. */
  primary: EmotionName
}

/**
 * Direct single-channel aliases. Semantically identical to the target —
 * same envelope, same body-clip lookup.
 *
 * Lowercased — resolver lower-cases the input before matching.
 */
const SYNONYMS: Record<string, EmotionName> = {
  // Reference-vocab single-channel aliases
  shyness: 'happy',
  sadness: 'sad',
  // LLM-emitted synonyms we accepted in the previous single-emotion
  // version of the controller; kept for back-compat so older turns still
  // render correctly.
  joy: 'happy',
  surprise: 'surprised',
  shocked: 'surprised',
  calm: 'relaxed',
  mad: 'angry',
  sorrowful: 'sad',
  upset: 'sad',
  // `excited` used to alias to `happy`; now the LLM can emit the explicit
  // multi-channel `excitement` (see RECIPES) — but keep the short alias
  // around in case the model falls back to the adjective.
  excited: 'happy',
  // `thinking` / `think` used to fire `relaxed`; keep for back-compat.
  thinking: 'relaxed',
  think: 'relaxed',
}

/**
 * Multi-channel blend recipes. `primary` is the dominant component — it's
 * what the animation controller looks up for a paired body clip.
 */
const RECIPES: Record<string, EmotionComponents> = {
  curiosity: {
    primary: 'surprised',
    face: [
      { name: 'surprised', weight: 0.4 },
      { name: 'happy', weight: 0.15 },
    ],
  },
  excitement: {
    primary: 'happy',
    face: [
      { name: 'happy', weight: 0.75 },
      { name: 'surprised', weight: 0.55 },
    ],
  },
  love: {
    primary: 'happy',
    face: [
      { name: 'happy', weight: 0.6 },
      { name: 'relaxed', weight: 0.35 },
    ],
  },
  stress: {
    primary: 'sad',
    face: [
      { name: 'sad', weight: 0.45 },
      { name: 'angry', weight: 0.25 },
    ],
  },
  frustration: {
    primary: 'angry',
    face: [
      { name: 'angry', weight: 0.7 },
      { name: 'sad', weight: 0.25 },
    ],
  },
}

/**
 * Names the LLM is allowed to emit via `<|ACT:{"emotion":"…"}|>`. This is
 * the union of the 6 VRM primaries + the reference-vocab additions. The
 * system prompt renders this list so the model knows what's available.
 *
 * Ordering is the list the user sees in the prompt — primaries first, then
 * extended emotions in rough intensity order.
 */
export const ALLOWED_EMOTION_NAMES: readonly string[] = [
  'happy',
  'sad',
  'angry',
  'surprised',
  'relaxed',
  'neutral',
  // Extended reference-vocab emotions — all resolve to primaries above.
  'curiosity',
  'shyness',
  'excitement',
  'love',
  'stress',
  'frustration',
  'sadness',
]

/**
 * Resolve any emotion name (primary, synonym, or recipe) into its canonical
 * drive. Returns null for unknown names — callers should silently skip, same
 * policy the rest of the marker system uses.
 */
export function resolveEmotion(raw: string): EmotionComponents | null {
  const lower = raw.toLowerCase()

  // Primary — direct match to a VRM blendshape.
  if ((PRESET_EMOTIONS as readonly string[]).includes(lower)) {
    const name = lower as EmotionName
    return { primary: name, face: [{ name, weight: 1 }] }
  }

  // Synonym — behaves exactly like the aliased primary.
  const synonym = SYNONYMS[lower]
  if (synonym) {
    return { primary: synonym, face: [{ name: synonym, weight: 1 }] }
  }

  // Multi-channel recipe.
  const recipe = RECIPES[lower]
  if (recipe) return recipe

  return null
}

/**
 * Does firing this emotion also fire a body clip on the active preset?
 *
 * `boundPrimaries` is the set of primary emotion names that have a paired
 * `kind: 'emotion'` animation on the active preset (derived from
 * `VRMAnimationEntry.emotion`). The resolver projects the incoming name to
 * its primary; if the primary is in that set, we get the body clip for free.
 */
export function emotionHasBodyAnimation(
  name: string,
  boundPrimaries: ReadonlySet<string>,
): boolean {
  const resolved = resolveEmotion(name)
  if (!resolved) return false
  return boundPrimaries.has(resolved.primary)
}
