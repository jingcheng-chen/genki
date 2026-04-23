import { z } from 'zod'

/**
 * Memory system — shared schemas and prompt builders.
 *
 * The extractor route uses `generateObject` against `ExtractorResultSchema`
 * so we get strict JSON validation on the LLM response and never have to
 * hand-parse the model's markdown.
 */

/**
 * Category union. Mirrors `src/types/memory.ts` Category — kept in sync
 * by hand since the server and client sides aren't sharing a workspace
 * yet. If we add a category, both files change in the same PR.
 */
export const CATEGORY_VALUES = [
  'durable',
  'preference',
  'episodic',
  'emotional',
  'relational',
] as const

const CategoryEnum = z.enum(CATEGORY_VALUES)

/**
 * Shape returned by `/api/memory/extract`. Matches PLAN.md §5 "fact
 * extractor prompt".
 */
export const ExtractorResultSchema = z.object({
  new_facts: z
    .array(
      z.object({
        content: z.string().min(1).describe('Natural-language fact, one sentence.'),
        category: CategoryEnum,
        importance: z.number().min(0).max(1),
      }),
    )
    .describe('Facts NOT already in memory that are durable enough to remember. Drop importance < 0.3.'),
  reinforced_fact_ids: z
    .array(z.string())
    .describe('Existing fact IDs that were referenced or confirmed in this turn.'),
  outdated_fact_ids: z
    .array(z.string())
    .describe('Existing fact IDs that this turn supersedes (e.g. user moved, finished a project).'),
})

export type ExtractorResult = z.infer<typeof ExtractorResultSchema>

/**
 * Shape returned by `/api/memory/compact`. Deliberately tiny — the
 * compactor prompt is "rewrite to N words", so the LLM just hands us
 * a string back.
 */
export const CompactorResultSchema = z.object({
  content: z.string().min(1),
})

export type CompactorResult = z.infer<typeof CompactorResultSchema>

/**
 * Assembles the fact-extractor prompt. Input is the last user turn,
 * the last assistant turn, and the retrieved fact IDs that were in
 * the system prompt this turn.
 *
 * The LLM is told to emit JSON matching ExtractorResultSchema; the
 * AI SDK's `generateObject` enforces that contract at the adapter
 * level (no hand-parsing required).
 */
export function buildExtractorPrompt(input: {
  userTurn: string
  assistantTurn: string
  retrievedFacts: Array<{ id: string; content: string; category: string }>
}): string {
  const existing =
    input.retrievedFacts.length === 0
      ? '(none)'
      : input.retrievedFacts
          .map((f) => `- [${f.id}] (${f.category}) ${f.content}`)
          .join('\n')

  return [
    'You are a memory curator for a conversational AI companion.',
    '',
    'Given the most recent user/assistant turn and the memory facts that were retrieved for it,',
    'produce structured output describing what should change in the memory.',
    '',
    'Categories:',
    '- durable:     identity-level facts that do not change (name, birthdate, birth country).',
    '- relational:  important people in their life (partner, close family, best friend).',
    '- preference:  persistent likes, dislikes, values, opinions.',
    '- emotional:   feelings toward specific things (loves their job, hates their landlord).',
    '- episodic:    one-off events, recent happenings, short-lived states.',
    '',
    'Importance guidance:',
    '- 1.0           identity / permanent (name, location they live in, family).',
    '- 0.7 to 0.9    strong preferences, current projects, important relationships.',
    '- 0.3 to 0.6    recent episodes, feelings, mild preferences.',
    '- below 0.3     DO NOT emit. Drop as noise.',
    '',
    'Rules:',
    '- Do NOT store the conversation itself. Store what the user IS, WANTS, FEELS, or DID.',
    '- Do NOT store trivia ("user said hi"). Only store signal.',
    '- Prefer REINFORCING an existing fact over creating a near-duplicate. If the user just',
    '  confirmed something already in memory, put its id in reinforced_fact_ids.',
    '- If a turn invalidates an existing fact (moved to a new city, changed jobs, finished a',
    '  project), put its id in outdated_fact_ids. The replacement (if any) goes in new_facts.',
    '',
    'Existing memory facts retrieved for this turn:',
    existing,
    '',
    'User turn:',
    input.userTurn,
    '',
    'Assistant turn:',
    input.assistantTurn,
    '',
    'Output strictly in the required JSON shape — no prose.',
  ].join('\n')
}

/**
 * Assembles the per-fact compactor prompt. The target word count
 * shrinks as compressionLevel climbs; see `COMPRESSION_TARGET_WORDS`
 * in `src/types/memory.ts`.
 */
export function buildCompactorPrompt(input: {
  content: string
  targetWords: number
}): string {
  return [
    `Compress the following memory fact to about ${input.targetWords} words or fewer.`,
    'Preserve gist and who/what/when if relevant; drop specifics, quotes, and adjectives.',
    'Write ONE short sentence. No preamble, no quotes, no markdown.',
    '',
    'Fact:',
    input.content,
  ].join('\n')
}
