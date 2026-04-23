/**
 * Builds the memory block injected into the system prompt.
 *
 * Selection policy (PLAN.md §5):
 *  - All `durable` + `preference` + `relational` facts (always-in-context;
 *    they're small and carry identity-level signal).
 *  - Top-K (K=10) of `episodic` + `emotional` by `importance × retention`.
 *  - All `compressionLevel >= 2` summaries (already compact by design).
 *
 * Output is grouped into three human-readable sections:
 *   "About them", "Recent context", "Longer history".
 *
 * Call stack (conceptual):
 *
 * buildMemoryBlock
 *   -> {@link loadFacts}
 *   -> {@link rankFacts}
 */

import { rankFacts } from './decay'
import { loadFacts } from './repo'
import type { MemoryFact } from '../types/memory'

/**
 * Number of episodic/emotional facts surfaced for the "Recent context"
 * section. Lower keeps prompts cheap; higher reduces the chance of the
 * model forgetting a mid-importance episode it needs this turn.
 */
export const TOP_K_EPISODIC = 10

/**
 * Heading the block opens with. Matches PLAN.md §5's retriever output
 * so the LLM sees consistent phrasing across turns.
 */
export const MEMORY_BLOCK_HEADING = '## What you remember about them'

export interface MemoryBlockResult {
  /** Full memory block text. Empty string if no facts survive ranking. */
  text: string
  /** Ids of every fact that ended up in the block — the extractor needs
   *  this to reason about which facts were "in context" this turn. */
  retrievedFactIds: string[]
}

/**
 * Loads the character's memory file and assembles the injection block.
 *
 * Use when:
 * - Turn controller is about to call `runTurn`; pass the returned
 *   `text` as `memoryBlock` and the `retrievedFactIds` through to the
 *   extractor.
 *
 * Expects:
 * - `characterId` matches a preset id. Missing files return an empty
 *   block (no error).
 *
 * Returns:
 * - `{ text, retrievedFactIds }`. `text` is an empty string when no
 *   facts match — the prompt builder treats empty as "skip the block".
 */
export async function buildMemoryBlock(
  characterId: string,
  opts: { now?: Date } = {},
): Promise<MemoryBlockResult> {
  const facts = await loadFacts(characterId)
  if (facts.length === 0) return { text: '', retrievedFactIds: [] }
  return assembleMemoryBlock(facts, opts.now ?? new Date())
}

/**
 * Pure version of `buildMemoryBlock` — given facts and `now`, returns
 * the injection text. Exposed for tests and (future) offline analysis.
 */
export function assembleMemoryBlock(
  facts: MemoryFact[],
  now: Date,
): MemoryBlockResult {
  const always: MemoryFact[] = []
  const episodicPool: MemoryFact[] = []
  const compressedHistory: MemoryFact[] = []

  for (const f of facts) {
    if (
      f.category === 'durable' ||
      f.category === 'preference' ||
      f.category === 'relational'
    ) {
      always.push(f)
      continue
    }
    // Episodic / emotional live in the pool. Any fact with
    // compressionLevel >= 2 also goes into the "Longer history"
    // section, even if it already made the recent cut; the summary
    // section dedupes by id below.
    if (f.compressionLevel >= 2) {
      compressedHistory.push(f)
    } else {
      episodicPool.push(f)
    }
  }

  const topEpisodic = rankFacts(episodicPool, now).slice(0, TOP_K_EPISODIC)

  const alwaysSection = formatSection('About them:', always)
  const recentSection = formatSection('Recent context:', topEpisodic)
  const longerSection = formatSection('Longer history:', compressedHistory)

  const sections = [alwaysSection, recentSection, longerSection].filter(Boolean)
  if (sections.length === 0) return { text: '', retrievedFactIds: [] }

  const retrievedFactIds = [
    ...always,
    ...topEpisodic,
    ...compressedHistory,
  ].map((f) => f.id)

  const text = [MEMORY_BLOCK_HEADING, '', ...sections].join('\n')
  return { text, retrievedFactIds }
}

/**
 * Formats a named section as:
 *
 *   Section label:
 *   - fact one.
 *   - fact two.
 */
function formatSection(label: string, facts: MemoryFact[]): string {
  if (facts.length === 0) return ''
  const lines = [label]
  for (const f of facts) {
    lines.push(`- ${f.content}`)
  }
  lines.push('')
  return lines.join('\n')
}
