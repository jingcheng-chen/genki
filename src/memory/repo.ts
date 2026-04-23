/**
 * Per-character memory repository.
 *
 * Storage: `idb-keyval` under the key `memory:<characterId>`. The value
 * is the serialized markdown string — keeping it text-first means a
 * debug panel can render it verbatim and hand-edits survive reloads.
 *
 * Concurrency:
 *   Extractor and compactor can both fire off background writes. We
 *   serialize writes per-character via an internal Promise chain
 *   ("write mutex") so overlapping mutations never drop updates. Reads
 *   are lock-free — they parse the latest committed string.
 *
 * Call stack (conceptual):
 *
 * loadFacts
 *   -> {@link getFacts}
 *     -> {@link parseMemoryMarkdown}
 *
 * insertFacts / reinforceFacts / deleteFacts
 *   -> {@link enqueueWrite}
 *     -> {@link getFacts}
 *     -> mutate
 *     -> {@link saveFacts}
 */

import { get, set, del } from 'idb-keyval'
import { parseMemoryMarkdown, stringifyMemoryMarkdown } from './format'
import type { Category, MemoryFact } from '../types/memory'
import { LOCAL_USER_ID } from '../types/memory'

/**
 * Key prefix used by the memory repo. Per-character files live at
 * `memory:<characterId>`. This matches PLAN.md's "one file per preset id"
 * decision (no auth in v1, so userId is implicit).
 */
export const MEMORY_KEY_PREFIX = 'memory:'

/** Builds the IndexedDB key for a given character. */
function keyFor(characterId: string): string {
  return `${MEMORY_KEY_PREFIX}${characterId}`
}

/**
 * Serialized write mutex per character. Assigning `writeChains[id] =
 * writeChains[id].then(...)` means each call tails the previous call
 * even if the previous call is still pending.
 */
const writeChains = new Map<string, Promise<void>>()

/**
 * Ensures a mutation runs after any prior mutation for the same
 * character has flushed. Errors in `fn` are swallowed at the chain
 * level (but re-thrown to the caller) so the chain stays alive.
 */
function enqueueWrite<T>(
  characterId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = writeChains.get(characterId) ?? Promise.resolve()
  // NOTICE:
  // We split the chain into a "link" (for ordering only; always
  // resolves) and a "result" (what the caller awaits, which may reject).
  // Without this split a throwing write would kill the chain and
  // subsequent writes would reject immediately.
  // Root cause: Promise chains propagate rejections.
  // Source: Standard JS semantics.
  // Removal condition: never — the split is the fix.
  let resolveLink: () => void = () => {}
  const link = new Promise<void>((r) => { resolveLink = r })
  writeChains.set(characterId, prev.then(() => link))

  const result = prev
    .catch(() => {})
    .then(fn)
    .finally(() => resolveLink())
  return result
}

/**
 * Reads the raw markdown from IndexedDB. Returns empty string if the
 * key doesn't exist. Safe to call from multiple tabs; we don't lock
 * reads.
 */
async function readRaw(characterId: string): Promise<string> {
  const raw = await get<string>(keyFor(characterId))
  return typeof raw === 'string' ? raw : ''
}

/**
 * Writes the raw markdown to IndexedDB.
 */
async function writeRaw(characterId: string, body: string): Promise<void> {
  await set(keyFor(characterId), body)
}

/**
 * Loads and parses all facts for a character. Stamps `characterId` /
 * `userId` from the caller, overriding whatever the file header says —
 * a hand-edited file can carry a stale header without corrupting the
 * runtime state.
 *
 * Use when:
 * - The retriever is assembling the memory block.
 * - The inspector UI is rendering facts.
 *
 * Expects:
 * - `characterId` matches the preset id of the character.
 *
 * Returns:
 * - Array of facts in file order. Empty if no file.
 */
export async function loadFacts(characterId: string): Promise<MemoryFact[]> {
  const raw = await readRaw(characterId)
  const parsed = parseMemoryMarkdown(raw)
  // Stamp characterId/userId from the caller — file-header drift
  // shouldn't corrupt in-memory state.
  return parsed.map((f) => ({
    ...f,
    characterId,
    userId: f.userId || LOCAL_USER_ID,
  }))
}

/**
 * Overwrites the on-disk facts with the given array. Caller is
 * responsible for already holding a mutation lock if needed — the
 * public mutation helpers below do this automatically.
 *
 * Use when:
 * - Inspector "Clear memory" confirms.
 * - Programmatic full rewrite after bulk ops (e.g. compactor).
 */
export async function saveFacts(
  characterId: string,
  facts: MemoryFact[],
): Promise<void> {
  await enqueueWrite(characterId, async () => {
    const body = stringifyMemoryMarkdown(facts, { characterId })
    await writeRaw(characterId, body)
  })
}

/** Shorthand for the common pattern of load → transform → save. */
async function mutate(
  characterId: string,
  fn: (facts: MemoryFact[]) => MemoryFact[],
): Promise<void> {
  await enqueueWrite(characterId, async () => {
    const raw = await readRaw(characterId)
    const facts = parseMemoryMarkdown(raw).map((f) => ({
      ...f,
      characterId,
      userId: f.userId || LOCAL_USER_ID,
    }))
    const next = fn(facts)
    const body = stringifyMemoryMarkdown(next, { characterId })
    await writeRaw(characterId, body)
  })
}

/**
 * Input shape for `insertFacts`. The caller provides the semantic
 * content; we fill in the ids, timestamps, and runtime fields.
 */
export interface NewFactInput {
  content: string
  category: Category
  importance: number
  sourceMessageIds?: string[]
}

/**
 * Inserts new facts. Runtime fields (id, timestamps, accessCount,
 * compressionLevel) are filled in automatically. Deduplication happens
 * at the extractor layer — the repo trusts its caller.
 */
export async function insertFacts(
  characterId: string,
  newFacts: NewFactInput[],
  opts: { now?: Date } = {},
): Promise<MemoryFact[]> {
  if (newFacts.length === 0) return []
  const nowIso = (opts.now ?? new Date()).toISOString()
  const inserted: MemoryFact[] = []

  await mutate(characterId, (existing) => {
    for (const n of newFacts) {
      const importance = Math.max(0, Math.min(1, n.importance))
      const fact: MemoryFact = {
        id: makeFactId(),
        characterId,
        userId: LOCAL_USER_ID,
        content: n.content.trim(),
        category: n.category,
        createdAt: nowIso,
        lastAccessedAt: nowIso,
        accessCount: 0,
        importance,
        compressionLevel: 0,
        sourceMessageIds: n.sourceMessageIds ?? [],
      }
      existing.push(fact)
      inserted.push(fact)
    }
    return existing
  })

  return inserted
}

/**
 * Bumps accessCount and resets lastAccessedAt on the given facts. Used
 * by the extractor when the LLM references an existing fact.
 */
export async function reinforceFacts(
  characterId: string,
  ids: string[],
  now: Date = new Date(),
): Promise<void> {
  if (ids.length === 0) return
  const ref = new Set(ids)
  const nowIso = now.toISOString()
  await mutate(characterId, (facts) =>
    facts.map((f) =>
      ref.has(f.id)
        ? { ...f, accessCount: f.accessCount + 1, lastAccessedAt: nowIso }
        : f,
    ),
  )
}

/**
 * Deletes the listed facts. Used by the extractor for outdated facts
 * and by the compactor for L3 facts below 0.05 retention.
 */
export async function deleteFacts(
  characterId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  const ref = new Set(ids)
  await mutate(characterId, (facts) => facts.filter((f) => !ref.has(f.id)))
}

/**
 * Replaces a single fact in place. Used by the compactor to rewrite
 * content and bump compressionLevel.
 */
export async function updateFact(
  characterId: string,
  id: string,
  patch: Partial<MemoryFact>,
): Promise<void> {
  await mutate(characterId, (facts) =>
    facts.map((f) => (f.id === id ? { ...f, ...patch, id: f.id } : f)),
  )
}

/**
 * Wipes all memory for a character. Used by the inspector "Clear
 * memory" button.
 */
export async function clearFacts(characterId: string): Promise<void> {
  await enqueueWrite(characterId, async () => {
    await del(keyFor(characterId))
  })
}

/**
 * Generates a short-ish fact id. Not cryptographically random — we
 * just need uniqueness within a character's fact set.
 *
 * Before: n/a
 * After: "f_a8c93f"
 */
function makeFactId(): string {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  const time = Date.now().toString(36).slice(-4)
  return `f_${time}${rand}`
}

// ---------------------------------------------------------------------------
// Debug hook (DEV only) — attach a memory inspector to `window.__dbg_memory`
// so manual testing via the browser console is painless.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __dbg_memory?: {
      load: typeof loadFacts
      save: typeof saveFacts
      clear: typeof clearFacts
      insert: typeof insertFacts
      reinforce: typeof reinforceFacts
      delete: typeof deleteFacts
    }
  }
}

if (
  typeof window !== 'undefined' &&
  typeof import.meta !== 'undefined' &&
  import.meta.env?.DEV
) {
  window.__dbg_memory = {
    load: loadFacts,
    save: saveFacts,
    clear: clearFacts,
    insert: insertFacts,
    reinforce: reinforceFacts,
    delete: deleteFacts,
  }
}
