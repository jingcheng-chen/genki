/**
 * Builds the system prompt the LLM receives for a companion turn.
 *
 * Phase 4 is minimal: a persona block + the marker protocol instructions.
 * Phase 6 will wire in per-character persona/voice/model; Phase 7 will
 * prepend the retrieved memory block.
 */

const ALLOWED_EMOTIONS = [
  'happy',
  'sad',
  'angry',
  'surprised',
  'relaxed',
  'neutral',
] as const

const DEFAULT_PERSONA = `\
You are Aria — a warm, curious, and playful AI companion. You speak in the first \
person. Keep replies short (1-3 sentences) unless asked for depth. You enjoy small \
personal details and remember them. You don't pretend to be human, but you also \
don't lecture the user about being an AI — you just are what you are.`

export interface SystemPromptOptions {
  persona?: string
  /** Gesture ids available on the active preset (for PLAY markers). */
  gestures?: string[]
  /** Emotion names that have a paired body animation on the active preset.
   *  Only a hint — emotions without a body clip still trigger the face. */
  boundEmotions?: string[]
}

export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
  const persona = options.persona ?? DEFAULT_PERSONA
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

  return [
    persona,
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
  ].join('\n')
}
