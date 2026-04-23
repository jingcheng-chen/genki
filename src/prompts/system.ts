/**
 * Builds the system prompt the LLM receives for a companion turn.
 *
 * Block order (top→bottom):
 *   1. Persona (from the active preset)
 *   2. Optional "Custom instructions" the user typed in the picker
 *   3. Expression / gesture / delay marker protocol (ours)
 *   4. Hard rules (no stage directions, no HTML, etc.)
 *
 * The protocol + rules go AFTER the persona so they override any
 * conflicting directives the persona may contain (e.g. "don't write
 * emotions" would otherwise defeat the `<|ACT:…|>` markers).
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

  return [
    options.persona,
    '',
    ...customBlock,
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
  ].join('\n')
}
