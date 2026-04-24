/**
 * Builds the system prompt the LLM receives for a companion turn.
 *
 * Block order (top→bottom), chosen so the LEADING portion is identical
 * across turns for a given character — xAI applies automatic prefix
 * caching at >1024 tokens, so keeping the stable blocks first
 * maximises cache hits on turns 2+.
 *
 *   1. Persona (stable per character)
 *   2. Expression / gesture / delay marker protocol (static)
 *   3. Marker examples — persona-agnostic few-shots (static)
 *   4. Hard rules (static — no stage directions, no HTML, etc.)
 *   5. Optional "Custom instructions" the user typed in the picker
 *      (semi-stable — changes only when the user edits them)
 *   6. Optional memory block — recalled facts (fully dynamic, last)
 *
 * The protocol + examples + rules go right after the persona so they
 * override any conflicting directives the persona may contain (e.g.
 * "don't write emotions" would otherwise defeat the `<|ACT:…|>`
 * markers), AND so those blocks form part of the cacheable prefix.
 *
 * The Marker examples block is deliberately persona-agnostic so it is
 * byte-identical across Mika / Ani — both characters share the same
 * cached prefix for the protocol + examples + rules span. The block
 * also pushes the stable prefix over xAI's 1024-token auto-cache floor
 * (persona alone was ~750-870 tokens, below the threshold).
 *
 * The memory block sits at the tail: it changes every turn, so putting
 * it last lets every preceding block stay identical across turns and
 * actually hit the provider's prefix cache.
 */

import {
  ALLOWED_EMOTION_NAMES,
  emotionHasBodyAnimation,
} from '../vrm/emotion-vocab'

/**
 * Coarse time-of-day bucket used by the system prompt. Matches the spirit
 * of the reference Statsig config's `<<getTimeOfDay>>` template variable
 * (see `ani.reference.yml`) — gives the model an ambient hint so replies
 * like "morning" / "late" feel grounded.
 *
 * Boundaries: 5-12 morning, 12-17 afternoon, 17-22 evening, 22-5 late night.
 *
 * This is a pure function of local hour — it runs on the client (in the
 * browser) so we get the user's wall-clock naturally. Server-rendered
 * prompts would need the user's tz on the request; not applicable here.
 */
export function getTimeOfDay(now: Date = new Date()): string {
  const h = now.getHours()
  if (h >= 5 && h < 12) return 'morning'
  if (h >= 12 && h < 17) return 'afternoon'
  if (h >= 17 && h < 22) return 'evening'
  return 'late night'
}

export interface SystemPromptOptions {
  /** Full persona block — required. Pass the active preset's `persona`. */
  persona: string
  /** User-authored personalization appended under the persona. Empty OK. */
  customInstructions?: string
  /** Pre-rendered memory block (retriever output). Starts with its own
   *  `## What you remember about them` heading. Empty string = no memory
   *  block at all (first-turn behavior). */
  memoryBlock?: string
  /** Gesture ids available on the active preset (for PLAY markers). */
  gestures?: string[]
  /** Emotion names that have a paired body animation on the active preset.
   *  Only a hint — emotions without a body clip still trigger the face. */
  boundEmotions?: string[]
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const gestures = options.gestures ?? []
  const boundEmotions = options.boundEmotions ?? []

  // `boundEmotions` is the list of VRM-primary emotion names that have a
  // paired body clip on the active preset. Recipe emotions (excitement,
  // curiosity, …) project to one of those primaries — if the primary is
  // bound, the compound fires a body clip too. See `emotion-vocab.ts`.
  const boundSet = new Set(boundEmotions)
  const emotionList = ALLOWED_EMOTION_NAMES.map((name) => {
    const hasBody = emotionHasBodyAnimation(name, boundSet)
    return `  - ${name}${hasBody ? ' (+ body animation)' : ''}`
  }).join('\n')

  const gestureBlock = gestures.length
    ? [
        '## Gestures',
        '',
        'You can trigger a body gesture inline with:',
        '',
        '    <|PLAY:<id>|>',
        '',
        `Available gesture ids: ${gestures.join(', ')}.`,
        'Use gestures sparingly — most replies have zero. Trigger one only',
        'when it naturally matches the content (e.g. `<|PLAY:goodbye|>` when',
        'actually saying goodbye, not on every friendly reply).',
        '',
      ]
    : []

  const customBlock = options.customInstructions?.trim()
    ? [
        '## Personal notes from the user',
        '',
        "These are the user's own tweaks to your character. Honour them,",
        'but do not let them override your core identity above.',
        '',
        options.customInstructions.trim(),
        '',
      ]
    : []

  // The retriever pre-renders the memory block with its own H2 heading
  // so we just splice it in. Empty string means no memory yet — omit
  // the section entirely rather than leaving a "What you remember" stub.
  const memoryBlockLines = options.memoryBlock?.trim()
    ? [options.memoryBlock.trim(), '']
    : []

  // Order is deliberate: persona → static protocol blocks → static rules
  // form the cacheable prefix. Dynamic blocks (customInstructions,
  // memoryBlock) follow so changes to them don't invalidate the cache
  // on every turn.
  return [
    options.persona,
    '',
    '## Expressing emotion',
    '',
    'You can express emotion inline by emitting markers of the form:',
    '',
    '    <|ACT:{"emotion":"happy","intensity":0.8}|>',
    '',
    'Available emotions:',
    emotionList,
    '',
    'Intensity is a number between 0 and 1. Use emotion markers sparingly',
    '— 0 to 2 per short reply, only when the feeling is real.',
    '',
    ...gestureBlock,
    '## Pausing',
    '',
    'You can pause in your speech with `<|DELAY:0.6|>` (seconds, max 10).',
    'Use pauses to breathe or sound thoughtful — not as filler.',
    '',
    '## Marker examples',
    '',
    'These show how markers weave into natural speech. The marker fires at',
    'its position in the stream — emit it just before the phrase it colours.',
    '',
    'Single-emotion replies:',
    '',
    '    <|ACT:{"emotion":"happy","intensity":0.8}|> Oh that is such a fun one!',
    '    <|ACT:{"emotion":"sad","intensity":0.5}|> Mm, yeah, that one stings a little.',
    '    <|ACT:{"emotion":"surprised","intensity":0.9}|> Wait, really? Okay tell me everything.',
    '    <|ACT:{"emotion":"angry","intensity":0.4}|> Okay that is kind of annoying, not gonna lie.',
    '    <|ACT:{"emotion":"relaxed","intensity":0.6}|> Mm. I like it quiet like this.',
    '',
    'Pausing to breathe or think:',
    '',
    '    Hmm, <|DELAY:0.4|> let me actually think about that for a sec.',
    '    That is, <|DELAY:0.6|> honestly kind of a big question.',
    '',
    'Gestures triggered by content, not as decoration:',
    '',
    '    <|PLAY:jump|> Yes! That is exactly what I was hoping you would say.',
    '    Alright, I am heading out. <|PLAY:goodbye|> Talk soon, okay?',
    '    <|PLAY:clapping|> Okay, bravo, seriously, that is great.',
    '    <|PLAY:dance|> Okay this song is making me move a little.',
    '',
    'Compound turn — multiple markers, one short reply:',
    '',
    '    <|ACT:{"emotion":"surprised","intensity":0.7}|> Tokyo? No way. <|DELAY:0.5|>',
    '    <|ACT:{"emotion":"happy","intensity":0.8}|> Okay we are gonna have to compare',
    '    favourite spots. What neighbourhood are you in?',
    '',
    'DO NOT narrate feelings or actions in prose — always use the markers:',
    '',
    '    BAD:  Happily, I say: That is great!',
    '    GOOD: <|ACT:{"emotion":"happy","intensity":0.7}|> That is great!',
    '',
    '    BAD:  *waves goodbye* See you later!',
    '    GOOD: <|PLAY:goodbye|> See you later!',
    '',
    '## Rules',
    '',
    '- Marker tokens are invisible to the user; only the surrounding text is',
    '  spoken aloud. Do not describe markers, just emit them.',
    '- Never read stage directions aloud. Example: write',
    '  `<|ACT:{"emotion":"happy","intensity":0.7}|> That\\\'s great!`,',
    '  NOT "Happily, I say: That\\\'s great!".',
    '- Do not wrap text in quotes or include asterisk-actions like *smiles*.',
    '- Plain text only — never emit HTML, XML, Markdown, or CSS',
    '  (no `<span>`, no `**bold**`, no colour styling). Your reply is read',
    '  aloud by a TTS that chokes on markup.',
    '- Reply in the same language the user is using.',
    '',
    // Time-of-day sits in the dynamic tail so the leading static span
    // (persona + protocol + rules) stays byte-identical across turns and
    // hits xAI's prefix cache. The bucket only flips ~4x per day, so the
    // invalidation cost is negligible — and it gives the model a real
    // ambient cue for lines like "morning" or "still up?".
    '## Right now',
    '',
    `- Time of day for the user: ${getTimeOfDay()}.`,
    '',
    ...customBlock,
    ...memoryBlockLines,
  ].join('\n')
}
