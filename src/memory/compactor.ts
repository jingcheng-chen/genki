/**
 * Background memory compactor.
 *
 * Runs via `requestIdleCallback` (with a `setTimeout(…, 0)` fallback
 * for Safari) every N turns, plus a mandatory pass every M turns even
 * if the main thread has been busy.
 *
 * On each pass:
 *   - For every fact below a retention threshold (0.2) whose
 *     compressionLevel is < MAX_COMPRESSION_LEVEL, call the server to
 *     rewrite it to a shorter form and bump the level.
 *   - For every fact at L3 whose retention has dropped below 0.05,
 *     delete it outright.
 *
 * Single pass in flight per character at a time — the extractor and
 * compactor share the repo's write-mutex, but we also gate entry here
 * so we don't stack up 50 fetches against the server.
 *
 * Call stack (conceptual):
 *
 * maybeRunCompaction
 *   -> schedulePass
 *     -> runCompaction
 *       -> fetch /api/memory/compact (per fact)
 *       -> {@link updateFact} / {@link deleteFacts}
 */

import {
  deleteFacts,
  loadFacts,
  updateFact,
} from './repo'
import { retentionScore } from './decay'
import type { MemoryFact } from '../types/memory'
import { COMPRESSION_TARGET_WORDS, MAX_COMPRESSION_LEVEL } from '../types/memory'

/**
 * Turns since the last pass that will trigger an idle-time pass. The
 * compactor still waits for `requestIdleCallback` — this just makes
 * it eligible.
 */
const IDLE_TRIGGER_TURNS = 5

/**
 * Forced pass interval. Even if the main thread is hot and idle
 * callbacks never fire, we guarantee a compaction every FORCED_TURNS.
 */
const FORCED_TURNS = 25

/**
 * Below this retention, the fact gets a compaction pass.
 */
export const COMPACT_RETENTION_THRESHOLD = 0.2

/**
 * Below this retention AND at MAX_COMPRESSION_LEVEL, the fact is
 * deleted.
 */
export const DELETE_RETENTION_THRESHOLD = 0.05

interface CompactorState {
  /** Turns since the last pass for this character. */
  turnsSince: number
  /** Pass in flight? Guards entry. */
  inFlight: boolean
}

const states = new Map<string, CompactorState>()

function getState(characterId: string): CompactorState {
  let s = states.get(characterId)
  if (!s) {
    s = { turnsSince: 0, inFlight: false }
    states.set(characterId, s)
  }
  return s
}

/**
 * Called by the turn controller after each assistant turn. Decides
 * whether to schedule a pass.
 *
 * Use when:
 * - Exactly once per assistant turn, right after the extractor is
 *   enqueued.
 *
 * Expects:
 * - `characterId` matches a preset id.
 *
 * Returns:
 * - void. If a pass is scheduled, it happens asynchronously on an
 *   idle callback.
 */
export function maybeRunCompaction(characterId: string): void {
  const state = getState(characterId)
  state.turnsSince += 1

  const forced = state.turnsSince >= FORCED_TURNS
  const eligible = state.turnsSince >= IDLE_TRIGGER_TURNS
  if (!forced && !eligible) return
  if (state.inFlight) return

  schedulePass(characterId, forced)
}

/**
 * Schedules a compaction pass. Forced passes skip the idle wait so a
 * chatty user doesn't indefinitely defer them.
 */
function schedulePass(characterId: string, forced: boolean): void {
  const run = () => {
    void runCompaction(characterId)
  }
  if (forced) {
    setTimeout(run, 0)
    return
  }
  const ric =
    typeof globalThis !== 'undefined' && 'requestIdleCallback' in globalThis
      ? (globalThis as typeof globalThis & {
          requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number
        }).requestIdleCallback
      : null
  if (ric) {
    ric(run, { timeout: 5_000 })
  } else {
    setTimeout(run, 0)
  }
}

/**
 * Runs one compaction pass for a character. Safe to call directly
 * from tests/debug — the in-flight guard prevents overlap.
 */
export async function runCompaction(characterId: string): Promise<void> {
  const state = getState(characterId)
  if (state.inFlight) return
  state.inFlight = true
  try {
    const now = new Date()
    const facts = await loadFacts(characterId)
    if (facts.length === 0) return

    const toCompact: MemoryFact[] = []
    const toDelete: string[] = []

    for (const f of facts) {
      const r = retentionScore(f, now)
      if (f.compressionLevel >= MAX_COMPRESSION_LEVEL) {
        if (r < DELETE_RETENTION_THRESHOLD) toDelete.push(f.id)
        continue
      }
      if (r < COMPACT_RETENTION_THRESHOLD) toCompact.push(f)
    }

    for (const f of toCompact) {
      const nextLevel = Math.min(
        MAX_COMPRESSION_LEVEL,
        f.compressionLevel + 1,
      ) as 0 | 1 | 2 | 3
      const targetWords = COMPRESSION_TARGET_WORDS[nextLevel]
      try {
        const compact = await callCompactorEndpoint(f.content, targetWords)
        await updateFact(characterId, f.id, {
          content: compact,
          compressionLevel: nextLevel,
        })
      } catch (err) {
        console.error(
          '[memory:compactor] compact failed',
          f.id,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    if (toDelete.length) await deleteFacts(characterId, toDelete)

    // Reset the per-character counter only on a successful pass — a
    // failed pass still counts so a stubbornly failing server doesn't
    // schedule every turn.
    state.turnsSince = 0
  } finally {
    state.inFlight = false
  }
}

/**
 * POSTs to the server compactor endpoint. Returns the compressed
 * string.
 */
async function callCompactorEndpoint(
  content: string,
  targetWords: number,
): Promise<string> {
  const res = await fetch('/api/memory/compact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, targetWords }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(
      `compactor HTTP ${res.status}: ${errText.slice(0, 300) || res.statusText}`,
    )
  }
  const json = (await res.json()) as { content?: unknown }
  if (typeof json.content !== 'string' || !json.content.trim()) {
    throw new Error('compactor returned no content')
  }
  return json.content.trim()
}
