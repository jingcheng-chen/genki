import { beforeEach, describe, expect, it } from 'vitest'
import { clear } from 'idb-keyval'
import {
  clearFacts,
  deleteFacts,
  insertFacts,
  loadFacts,
  reinforceFacts,
  saveFacts,
  updateFact,
} from '../repo'

/**
 * Full IndexedDB round-trip tests against `fake-indexeddb/auto` (set up
 * via `src/memory/__tests__/setup.ts`). Each test clears the default
 * store so there's no cross-test bleed.
 */

beforeEach(async () => {
  await clear()
})

describe('repo', () => {
  /**
   * @example
   *   insertFacts({ content, category, importance }) → loadFacts sees them
   */
  it('inserts and loads facts with generated ids', async () => {
    const before = await loadFacts('mika')
    expect(before).toEqual([])

    const inserted = await insertFacts('mika', [
      { content: 'Name: Alice', category: 'durable', importance: 1 },
      {
        content: 'Prefers dark UI',
        category: 'preference',
        importance: 0.5,
      },
    ])
    expect(inserted.length).toBe(2)
    for (const f of inserted) {
      expect(f.id.startsWith('f_')).toBe(true)
      expect(f.characterId).toBe('mika')
      expect(f.compressionLevel).toBe(0)
      expect(f.accessCount).toBe(0)
    }

    const after = await loadFacts('mika')
    expect(after.length).toBe(2)
    const contents = after.map((f) => f.content).sort()
    expect(contents).toEqual(['Name: Alice', 'Prefers dark UI'])
  })

  /**
   * @example
   *   reinforceFacts(ids, now) bumps accessCount by 1 each time and
   *   updates lastAccessedAt.
   */
  it('reinforces an existing fact', async () => {
    const [fact] = await insertFacts(
      'mika',
      [{ content: 'Name: Alice', category: 'durable', importance: 1 }],
      { now: new Date('2026-04-01T00:00:00Z') },
    )

    await reinforceFacts('mika', [fact.id], new Date('2026-04-21T00:00:00Z'))

    const [after] = await loadFacts('mika')
    expect(after.accessCount).toBe(1)
    expect(after.lastAccessedAt).toBe('2026-04-21T00:00:00.000Z')
    expect(after.createdAt).toBe('2026-04-01T00:00:00.000Z')
  })

  /**
   * @example deleteFacts drops the listed ids and leaves the rest.
   */
  it('deletes facts by id', async () => {
    const inserted = await insertFacts('mika', [
      { content: 'A', category: 'episodic', importance: 0.5 },
      { content: 'B', category: 'episodic', importance: 0.5 },
      { content: 'C', category: 'episodic', importance: 0.5 },
    ])
    await deleteFacts('mika', [inserted[0].id, inserted[2].id])
    const after = await loadFacts('mika')
    expect(after.length).toBe(1)
    expect(after[0].id).toBe(inserted[1].id)
  })

  /**
   * @example updateFact patches arbitrary fields without losing the id.
   */
  it('updates a single fact in place', async () => {
    const [fact] = await insertFacts('mika', [
      {
        content: 'Original',
        category: 'episodic',
        importance: 0.5,
      },
    ])
    await updateFact('mika', fact.id, {
      content: 'Compressed',
      compressionLevel: 2,
    })
    const [after] = await loadFacts('mika')
    expect(after.id).toBe(fact.id)
    expect(after.content).toBe('Compressed')
    expect(after.compressionLevel).toBe(2)
  })

  /**
   * @example clearFacts wipes a character's file — subsequent loads see
   * an empty array.
   */
  it('clears all facts for a character', async () => {
    await insertFacts('mika', [
      { content: 'A', category: 'durable', importance: 1 },
    ])
    await clearFacts('mika')
    const after = await loadFacts('mika')
    expect(after).toEqual([])
  })

  /**
   * @example concurrent insert/reinforce/delete don't drop writes — the
   * write mutex serializes them.
   */
  it('serializes overlapping writes safely', async () => {
    const [fact] = await insertFacts('mika', [
      { content: 'Seed', category: 'durable', importance: 1 },
    ])

    // Fire a bunch of concurrent writes. Without the mutex,
    // later writes would load a stale version and clobber earlier writes.
    const batch: Array<Promise<unknown>> = []
    for (let i = 0; i < 10; i++) {
      batch.push(
        insertFacts('mika', [
          { content: `Concurrent ${i}`, category: 'episodic', importance: 0.5 },
        ]),
      )
      batch.push(reinforceFacts('mika', [fact.id]))
    }
    await Promise.all(batch)

    const after = await loadFacts('mika')
    // 1 seed + 10 new = 11 facts retained
    expect(after.length).toBe(11)
    const seed = after.find((f) => f.id === fact.id)
    expect(seed).toBeDefined()
    // 10 reinforcements fired — each bumps accessCount.
    expect(seed!.accessCount).toBe(10)
  })

  /**
   * @example two characters' stores are isolated.
   */
  it('keeps per-character files separate', async () => {
    await insertFacts('mika', [
      { content: 'Mika fact', category: 'durable', importance: 1 },
    ])
    await insertFacts('ani', [
      { content: 'Ani fact', category: 'durable', importance: 1 },
    ])
    const mika = await loadFacts('mika')
    const ani = await loadFacts('ani')
    expect(mika.length).toBe(1)
    expect(ani.length).toBe(1)
    expect(mika[0].content).toBe('Mika fact')
    expect(ani[0].content).toBe('Ani fact')
  })

  /**
   * @example saveFacts replaces the whole file.
   */
  it('saveFacts replaces the entire file', async () => {
    await insertFacts('mika', [
      { content: 'A', category: 'durable', importance: 1 },
    ])
    await saveFacts('mika', [])
    expect(await loadFacts('mika')).toEqual([])
  })
})
