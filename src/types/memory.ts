/**
 * Memory system data model.
 *
 * See PLAN.md §4.3 and §5 for the full design doc. Short version:
 *   - Facts are the unit of memory; they have a category, importance,
 *     access count, and compression level.
 *   - Retention follows Ebbinghaus's forgetting curve: the stability of
 *     a fact grows with importance, accessCount, and its category's
 *     baseline (see CATEGORY_BASE_STABILITY).
 *   - Storage is per-character-per-user; v1 has no auth so userId is
 *     effectively a constant ('local').
 */

/**
 * Fact category. Drives base stability and how the retriever groups
 * facts in the injected memory block.
 *
 * Use when:
 * - Classifying a new fact during extraction.
 * - Scoping retrieval queries (durable/preference/relational are always
 *   included; episodic/emotional go through top-K ranking).
 *
 * Returns: narrow union — widens are not allowed.
 */
export type Category =
  | 'durable'
  | 'preference'
  | 'episodic'
  | 'emotional'
  | 'relational'

/**
 * A single memory fact. Serialized line-by-line to markdown in the
 * per-character memory file (see `src/memory/format.ts`).
 *
 * Expects:
 * - `id` starts with `f_` and is locally unique per character.
 * - `createdAt` and `lastAccessedAt` are ISO 8601 strings.
 * - `importance` is clamped to [0, 1]; below 0.3 is dropped on insert.
 * - `compressionLevel` starts at 0; the compactor bumps it to at most 3.
 *
 * Returns: JSON-serializable; safe for structured clone.
 */
export interface MemoryFact {
  id: string
  characterId: string
  userId: string

  content: string
  category: Category

  createdAt: string
  lastAccessedAt: string
  accessCount: number

  importance: number
  compressionLevel: 0 | 1 | 2 | 3

  sourceMessageIds: string[]
}

/**
 * Per-category baseline stability in HOURS. Multiplied by importance and
 * accessCount multipliers in `computeStability`. Tuned so:
 *  - `durable` facts (name, location) are effectively never forgotten
 *    without user intervention.
 *  - `relational` facts (partner, close friends) survive a year untouched.
 *  - `preference` facts (likes/dislikes) survive ~6 months untouched.
 *  - `emotional` facts (feelings about specific events) survive a month.
 *  - `episodic` facts (one-off events) age over ~3 days baseline, after
 *    which compaction kicks in.
 *
 * Use when:
 * - Computing retention via `retentionScore` / `computeStability`.
 */
export const CATEGORY_BASE_STABILITY: Record<Category, number> = {
  durable: 24 * 365 * 10,
  relational: 24 * 365,
  preference: 24 * 180,
  emotional: 24 * 30,
  episodic: 72,
}

/**
 * Compression ceiling. A fact that's already at L3 and has decayed
 * below 0.05 retention is deleted on the next compaction pass.
 */
export const MAX_COMPRESSION_LEVEL = 3 as const

/**
 * Target word count per compression level. L0 is the raw extracted
 * fact (no cap), L1 is ~40 words, L2 is ~20, L3 is ~10 (single-clause
 * summary). The compactor uses these to prompt the LLM.
 */
export const COMPRESSION_TARGET_WORDS: Record<0 | 1 | 2 | 3, number> = {
  0: 9999,
  1: 40,
  2: 20,
  3: 10,
}

/**
 * Local single-user default. There's no auth in v1, so every fact
 * lands under this constant userId. When we add auth in a later phase,
 * the repo layer routes by the session user instead.
 */
export const LOCAL_USER_ID = 'local' as const
