/**
 * Human-curve decay model (Ebbinghaus + Pimsleur).
 *
 * Pure math — no I/O, no DOM, no dates from wall clock. `now` is an
 * explicit argument so tests and the retriever can use the same path.
 *
 * Call stack (conceptual):
 *
 * retentionScore
 *   -> {@link computeStability}
 *
 * rankFacts
 *   -> {@link retentionScore} (for each fact)
 */

import { CATEGORY_BASE_STABILITY, type MemoryFact } from '../types/memory'

/**
 * Computes fact stability in HOURS.
 *
 *   stability = base * (1 + 4*importance) * (1 + log2(1 + accessCount))
 *
 * Use when:
 * - Feeding `retentionScore` directly (retention uses exp(-t / S)).
 * - Debug UIs that want to display stability next to retention.
 *
 * Expects:
 * - `fact.importance` is any finite number; clamped to [0, 1] for safety.
 * - `fact.accessCount` is a non-negative integer.
 *
 * Returns:
 * - Positive finite number, in hours.
 */
export function computeStability(fact: MemoryFact): number {
  const base = CATEGORY_BASE_STABILITY[fact.category]
  const importance = Math.max(0, Math.min(1, fact.importance))
  const accessCount = Math.max(0, fact.accessCount)
  const importanceMul = 1 + 4 * importance
  const accessMul = 1 + Math.log2(1 + accessCount)
  return base * importanceMul * accessMul
}

/**
 * Retention at time `now` as a value in [0, 1].
 *
 *   retention = exp(-hoursSinceAccess / stability)
 *
 * Use when:
 * - Ranking facts for prompt injection.
 * - Deciding whether to compact (retention < 0.2) or delete (L3 + < 0.05).
 *
 * Expects:
 * - `fact.lastAccessedAt` is a valid ISO date string. Invalid input is
 *   treated as "accessed now" (retention = 1) — safer than throwing in
 *   the retrieval hot path.
 *
 * Returns:
 * - Number in (0, 1]. 1 at t=0, asymptotes to 0 as t grows.
 */
export function retentionScore(fact: MemoryFact, now: Date): number {
  const stability = computeStability(fact)
  const lastMs = Date.parse(fact.lastAccessedAt)
  if (!Number.isFinite(lastMs)) return 1
  const hoursSinceAccess = Math.max(0, (now.getTime() - lastMs) / 3.6e6)
  return Math.exp(-hoursSinceAccess / stability)
}

/**
 * Ranks facts by `importance * retention(now)`, descending.
 *
 * Use when:
 * - Selecting the top-K episodic/emotional facts for the memory block.
 *
 * Expects:
 * - Any array of facts (including mixed categories).
 *
 * Returns:
 * - A new array in ranked order. Ties broken by `accessCount` then by id
 *   so the ordering is deterministic for tests.
 */
export function rankFacts(facts: MemoryFact[], now: Date): MemoryFact[] {
  return facts
    .map((fact) => ({
      fact,
      score: Math.max(0, Math.min(1, fact.importance)) * retentionScore(fact, now),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.fact.accessCount !== a.fact.accessCount)
        return b.fact.accessCount - a.fact.accessCount
      return a.fact.id.localeCompare(b.fact.id)
    })
    .map((e) => e.fact)
}
