import { describe, expect, it } from 'vitest'
import { assembleMemoryBlock, TOP_K_EPISODIC } from '../retriever'
import type { Category, MemoryFact } from '../../types/memory'

/**
 * Pure retrieval/assembly tests — no IndexedDB, just the in-memory
 * selector logic. Keeps the happy path well-pinned.
 *
 * @example
 *   const { text } = assembleMemoryBlock([fact, ...], new Date(...))
 */
function makeFact(
  id: string,
  category: Category,
  patch: Partial<MemoryFact> = {},
): MemoryFact {
  const now = new Date('2026-04-21T00:00:00Z')
  return {
    id,
    characterId: 'mika',
    userId: 'local',
    content: `fact ${id}`,
    category,
    createdAt: now.toISOString(),
    lastAccessedAt: now.toISOString(),
    accessCount: 0,
    importance: 0.5,
    compressionLevel: 0,
    sourceMessageIds: [],
    ...patch,
  }
}

describe('assembleMemoryBlock', () => {
  /**
   * @example
   *   returns '' with no retrieved ids when there are zero facts.
   */
  it('returns empty output when no facts exist', () => {
    const { text, retrievedFactIds } = assembleMemoryBlock([], new Date())
    expect(text).toBe('')
    expect(retrievedFactIds).toEqual([])
  })

  /**
   * @example
   *   durable + preference + relational are always included; their
   *   content appears under "About them:".
   */
  it('always includes durable/preference/relational facts', () => {
    const facts: MemoryFact[] = [
      makeFact('f_durable', 'durable', { content: 'Name: Alice', importance: 1 }),
      makeFact('f_pref', 'preference', {
        content: 'Dislikes cilantro',
        importance: 0.5,
      }),
      makeFact('f_rel', 'relational', {
        content: 'Partner is Jamie',
        importance: 0.95,
      }),
    ]
    const { text, retrievedFactIds } = assembleMemoryBlock(
      facts,
      new Date('2026-04-21T00:00:00Z'),
    )
    expect(text).toContain('About them:')
    expect(text).toContain('Name: Alice')
    expect(text).toContain('Dislikes cilantro')
    expect(text).toContain('Partner is Jamie')
    expect(text).toContain('## What you remember about them')
    expect(retrievedFactIds).toEqual(
      expect.arrayContaining(['f_durable', 'f_pref', 'f_rel']),
    )
  })

  /**
   * @example
   *   respects TOP_K_EPISODIC cap — extra episodic facts drop off.
   */
  it('caps episodic facts at TOP_K_EPISODIC', () => {
    const facts: MemoryFact[] = []
    for (let i = 0; i < TOP_K_EPISODIC + 5; i++) {
      facts.push(
        makeFact(`f_${i}`, 'episodic', {
          importance: 0.5 + i * 0.01, // distinct importances → deterministic order
        }),
      )
    }
    const { retrievedFactIds } = assembleMemoryBlock(
      facts,
      new Date('2026-04-21T00:00:00Z'),
    )
    expect(retrievedFactIds.length).toBe(TOP_K_EPISODIC)
  })

  /**
   * @example
   *   episodic facts are ranked by importance * retention — the most
   *   important, recent facts win.
   */
  it('orders episodic facts by importance × retention', () => {
    const now = new Date('2026-04-21T00:00:00Z')
    const facts: MemoryFact[] = [
      makeFact('f_recent_high', 'episodic', {
        importance: 0.8,
        lastAccessedAt: now.toISOString(),
      }),
      makeFact('f_recent_low', 'episodic', {
        importance: 0.3,
        lastAccessedAt: now.toISOString(),
      }),
      makeFact('f_old_mid', 'episodic', {
        importance: 0.5,
        // ~150h ago — for episodic with default base 72h → retention ~ e^-2
        lastAccessedAt: new Date(
          now.getTime() - 150 * 3.6e6,
        ).toISOString(),
      }),
    ]
    const { retrievedFactIds } = assembleMemoryBlock(facts, now)
    // f_recent_high wins; f_recent_low has retention 1 but importance 0.3;
    // f_old_mid has importance 0.5 but retention < 0.2.
    expect(retrievedFactIds[0]).toBe('f_recent_high')
    expect(retrievedFactIds[1]).toBe('f_recent_low')
  })

  /**
   * @example
   *   L2 / L3 compressed facts always land in "Longer history" regardless
   *   of retention — they're already compact and cheap to include.
   */
  it('always includes compressionLevel >= 2 under "Longer history"', () => {
    const now = new Date('2026-04-21T00:00:00Z')
    const facts: MemoryFact[] = [
      makeFact('f_l2', 'episodic', {
        compressionLevel: 2,
        content: 'March 2026: started companion project',
        // way in the past → retention ≈ 0 — still should be present.
        lastAccessedAt: '2025-01-01T00:00:00Z',
      }),
      makeFact('f_l3', 'emotional', {
        compressionLevel: 3,
        content: '2025: stressed about deadlines',
        lastAccessedAt: '2025-01-01T00:00:00Z',
      }),
    ]
    const { text, retrievedFactIds } = assembleMemoryBlock(facts, now)
    expect(text).toContain('Longer history:')
    expect(text).toContain('March 2026: started companion project')
    expect(text).toContain('2025: stressed about deadlines')
    expect(retrievedFactIds).toEqual(['f_l2', 'f_l3'])
  })
})
