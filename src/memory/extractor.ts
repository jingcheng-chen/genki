/**
 * Background fact extractor.
 *
 * Fires after every assistant turn. Queue-of-one semantics: if a new
 * extraction is enqueued while one is in flight, the earlier one is
 * allowed to finish and the newer one waits — OR if the earlier one
 * hasn't started yet, the newer one replaces it (we only care about
 * the MOST RECENT enqueued extraction because the pipeline provides
 * its own context window; stale queue entries are redundant work).
 *
 * On success:
 *   - Deduplicate new_facts against the current fact set (case-insensitive
 *     + whitespace-normalized; ≥ 0.85 Jaccard on word sets, or substring
 *     containment).
 *   - Insert surviving new facts, reinforce reinforced_fact_ids, delete
 *     outdated_fact_ids.
 *
 * Failures are logged to console and retried up to 3 times with
 * exponential backoff (250 / 500 / 1000 ms). Never surfaces to UI.
 *
 * Call stack (conceptual):
 *
 * enqueueExtraction
 *   -> runExtraction (with retries)
 *     -> fetch /api/memory/extract
 *     -> dedupe + apply: insertFacts / reinforceFacts / deleteFacts
 */

import {
  deleteFacts,
  insertFacts,
  loadFacts,
  reinforceFacts,
  type NewFactInput,
} from './repo'
import type { Category, MemoryFact } from '../types/memory'

/** Importance threshold. Anything strictly below this is noise. */
export const IMPORTANCE_FLOOR = 0.3

/** Max retries per enqueued extraction. Logs and drops after this. */
const MAX_RETRIES = 3

/** Exponential backoff schedule in ms. Index is retry count (0..). */
const BACKOFF_MS = [250, 500, 1000] as const

const CATEGORY_SET: ReadonlySet<Category> = new Set([
  'durable',
  'preference',
  'episodic',
  'emotional',
  'relational',
])

export interface ExtractorJob {
  characterId: string
  userTurn: string
  assistantTurn: string
  /** IDs of the facts that made it into the system-prompt memory block
   *  this turn. The server LLM needs the content; we hydrate from the
   *  current fact set at send time. */
  retrievedFactIds: string[]
}

interface ExtractorResponse {
  new_facts: Array<{ content: string; category: Category; importance: number }>
  reinforced_fact_ids: string[]
  outdated_fact_ids: string[]
}

/**
 * Per-character queue-of-one state. `current` is the running promise;
 * `queued` is the next job if any. Jobs are keyed by character so a
 * fast user swap doesn't interleave Mika and Ani.
 */
interface QueueState {
  current: Promise<void> | null
  queued: ExtractorJob | null
}
const queues = new Map<string, QueueState>()

/**
 * Module-level turn counter used by the compactor to trigger passes.
 * Exposed via `getAndResetTurnCount` / `incrementTurnCount` so the
 * compactor and any tests can observe it.
 */
let globalTurnCount = 0

/**
 * Bumps the post-assistant-turn counter. Called by the extractor on
 * every enqueue, regardless of whether the fetch ultimately succeeds.
 * The compactor reads this to schedule compaction.
 */
export function incrementTurnCount(): number {
  globalTurnCount += 1
  return globalTurnCount
}

/** For tests/debug. Compactor does NOT reset it — it only reads. */
export function getTurnCount(): number {
  return globalTurnCount
}

/**
 * Enqueues a background extraction. Returns immediately.
 *
 * Use when:
 * - Turn controller just finished an assistant stream (calls us from
 *   `onStreamEnd`).
 *
 * Expects:
 * - `job.userTurn` and `job.assistantTurn` are the verbatim texts of
 *   the most recent turn; marker tokens are fine, the server prompt
 *   handles them.
 *
 * Returns:
 * - void. Errors never surface here.
 */
export function enqueueExtraction(job: ExtractorJob): void {
  incrementTurnCount()

  const state = queues.get(job.characterId) ?? { current: null, queued: null }
  if (!queues.has(job.characterId)) queues.set(job.characterId, state)

  if (state.current) {
    // Replace any queued job; the running one keeps going untouched.
    // We only ever need the latest context.
    state.queued = job
    return
  }

  const run = async () => {
    try {
      await runExtraction(job)
    } catch (err) {
      console.error('[memory:extractor] final failure', errMessage(err))
    } finally {
      state.current = null
      const nextJob = state.queued
      state.queued = null
      if (nextJob) {
        state.current = runWithCatch(() => runExtraction(nextJob))
      }
    }
  }
  state.current = runWithCatch(run)
}

/**
 * Wraps a job runner so the outer chain never rejects; unhandled
 * promise rejections from a background task shouldn't crash the app.
 */
function runWithCatch(fn: () => Promise<void>): Promise<void> {
  return fn().catch((err) => {
    console.error('[memory:extractor] unexpected', errMessage(err))
  })
}

/**
 * Runs a single extraction attempt, with up to MAX_RETRIES retries.
 */
async function runExtraction(job: ExtractorJob): Promise<void> {
  const existing = await loadFacts(job.characterId)
  const retrievedPayload = existing
    .filter((f) => job.retrievedFactIds.includes(f.id))
    .map((f) => ({ id: f.id, content: f.content, category: f.category }))

  let lastErr: unknown = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await callExtractorEndpoint({
        userTurn: job.userTurn,
        assistantTurn: job.assistantTurn,
        retrievedFacts: retrievedPayload,
      })
      await applyExtractorResult(job.characterId, existing, result)
      return
    } catch (err) {
      lastErr = err
      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
        await new Promise<void>((r) => setTimeout(r, delay))
      }
    }
  }
  throw lastErr ?? new Error('extractor failed without an error')
}

/**
 * POSTs to the server extractor endpoint and returns the structured
 * response. Throws on non-2xx.
 */
async function callExtractorEndpoint(body: {
  userTurn: string
  assistantTurn: string
  retrievedFacts: Array<{ id: string; content: string; category: string }>
}): Promise<ExtractorResponse> {
  const res = await fetch('/api/memory/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(
      `extractor HTTP ${res.status}: ${errText.slice(0, 300) || res.statusText}`,
    )
  }
  const json: ExtractorResponse = await res.json()
  return json
}

/**
 * Dedupes and applies the extractor's result to the repo. Pure
 * orchestration; the repo handles persistence and concurrency.
 */
async function applyExtractorResult(
  characterId: string,
  existing: MemoryFact[],
  result: ExtractorResponse,
): Promise<void> {
  const toInsert: NewFactInput[] = []
  const reinforce = new Set<string>(result.reinforced_fact_ids ?? [])

  for (const raw of result.new_facts ?? []) {
    if (!raw || typeof raw.content !== 'string') continue
    const content = raw.content.trim()
    if (!content) continue
    if (!CATEGORY_SET.has(raw.category)) continue
    if (!Number.isFinite(raw.importance)) continue
    const importance = Math.max(0, Math.min(1, raw.importance))
    // Safety gate: server-side prompt discourages <0.3, but we enforce
    // it here too so prompt regressions can't flood the store.
    if (importance < IMPORTANCE_FLOOR) continue

    const dupe = findDuplicate(existing, content, raw.category)
    if (dupe) {
      reinforce.add(dupe.id)
      continue
    }
    toInsert.push({ content, category: raw.category, importance })
  }

  // Apply mutations in a stable order: delete first (so a freshly
  // inserted fact can't accidentally match an outdated id), then insert,
  // then reinforce.
  const outdated = Array.isArray(result.outdated_fact_ids)
    ? result.outdated_fact_ids
    : []
  if (outdated.length) await deleteFacts(characterId, outdated)
  if (toInsert.length) await insertFacts(characterId, toInsert)
  if (reinforce.size) await reinforceFacts(characterId, Array.from(reinforce))
}

/**
 * Finds an existing fact that's essentially the same as the given
 * candidate. Returns null if none match.
 *
 * Matching rules (within the same category):
 *  - Case-insensitive + whitespace-normalized substring containment.
 *  - Jaccard similarity ≥ 0.85 on word sets (tokenized on \s+).
 */
export function findDuplicate(
  existing: MemoryFact[],
  candidate: string,
  category: Category,
): MemoryFact | null {
  const candNorm = normalize(candidate)
  const candTokens = tokenSet(candNorm)

  for (const fact of existing) {
    if (fact.category !== category) continue
    const factNorm = normalize(fact.content)
    if (!factNorm) continue
    if (candNorm === factNorm) return fact
    if (factNorm.includes(candNorm) || candNorm.includes(factNorm)) return fact
    const factTokens = tokenSet(factNorm)
    if (jaccard(candTokens, factTokens) >= 0.85) return fact
  }
  return null
}

/**
 * Lower-cases and collapses whitespace so "  Hi  There  " and "hi there"
 * compare equal.
 *
 * Before: "  Hi  There  "
 * After: "hi there"
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function tokenSet(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Test seams — not part of the public API. Kept at the bottom of the
// file so the main surface area stays clean.
// ---------------------------------------------------------------------------

/** @internal */
export const _internalForTests = {
  normalize,
  tokenSet,
  jaccard,
  applyExtractorResult,
}
