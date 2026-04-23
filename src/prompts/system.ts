/**
 * Builds the system prompt the LLM receives for a companion turn.
 *
 * Block order (top→bottom), chosen so the LEADING portion is identical
 * across turns for a given character — OpenRouter + xAI apply automatic
 * prefix caching at >1024 tokens, so keeping the stable blocks first
 * maximises cache hits on turns 2+.
 *
 *   1. Persona (stable per character)
 *   2. Expression / gesture / delay marker protocol (static)
 *   3. Hard rules (static — no stage directions, no HTML, etc.)
 *   4. Optional "Custom instructions" the user typed in the picker
 *      (semi-stable — changes only when the user edits them)
 *   5. Optional memory block — recalled facts (fully dynamic, last)
 *
 * The protocol + rules go right after the persona so they override any
 * conflicting directives the persona may contain (e.g. "don't write
 * emotions" would otherwise defeat the `<|ACT:…|>` markers), AND so
 * those blocks form part of the cacheable prefix.
 *
 * The memory block sits at the tail: it changes every turn, so putting
 * it last lets every preceding block stay identical across turns and
 * actually hit the provider's prefix cache.
 */

const ALLOWED_EMOTIONS = [
  'happy',
  'sad',
  'angry',
  'surprised',
  'relaxed',
  'neutral',
] as const

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

  const emotionList = ALLOWED_EMOTIONS.map((name) => {
    const bound = boundEmotions.includes(name) ? ' (+ body animation)' : ''
    return `  - ${name}${bound}`
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
    ...customBlock,
    ...memoryBlockLines,
  ].join('\n')
}
