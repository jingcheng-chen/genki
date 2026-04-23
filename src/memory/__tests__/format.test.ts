import { describe, it, expect } from 'vitest'
import { parseMemoryMarkdown, stringifyMemoryMarkdown } from '../format'
import type { MemoryFact } from '../../types/memory'

/** Small helper that builds a fact; every field is intentionally set so
 *  round-trip tests compare non-default values.
 *
 *  @example
 *   const f = makeFact({ id: 'f_a', content: 'Name: Alice' })
 */
function makeFact(patch: Partial<MemoryFact>): MemoryFact {
  return {
    id: 'f_default',
    characterId: 'mika',
    userId: 'local',
    content: 'placeholder',
    category: 'episodic',
    createdAt: '2026-04-20T12:00:00.000Z',
    lastAccessedAt: '2026-04-21T10:00:00.000Z',
    accessCount: 2,
    importance: 0.6,
    compressionLevel: 1,
    sourceMessageIds: ['m_1', 'm_2'],
    ...patch,
  }
}

describe('stringifyMemoryMarkdown + parseMemoryMarkdown', () => {
  /**
   * @example
   *   round-trip: stringify(parse(stringify(facts))) === stringify(facts)
   */
  it('round-trips a mixed set of facts', () => {
    const facts: MemoryFact[] = [
      makeFact({
        id: 'f_a',
        content: 'Name: Alice',
        category: 'durable',
        importance: 1,
        compressionLevel: 0,
        accessCount: 47,
      }),
      makeFact({
        id: 'f_b',
        content: 'Lives in Tokyo, Japan',
        category: 'durable',
        importance: 0.9,
        accessCount: 23,
      }),
      makeFact({
        id: 'f_c',
        content: 'Dislikes cilantro (strongly)',
        category: 'preference',
        importance: 0.6,
        compressionLevel: 1,
      }),
      makeFact({
        id: 'f_d',
        content: 'Passed React cert exam on 2026-04-21',
        category: 'episodic',
        importance: 0.8,
      }),
      makeFact({
        id: 'f_e',
        content: "Feels stressed about Friday's deadline",
        category: 'emotional',
        importance: 0.7,
      }),
      makeFact({
        id: 'f_f',
        content: "Partner's name is Jamie",
        category: 'relational',
        importance: 0.95,
      }),
    ]

    const text = stringifyMemoryMarkdown(facts, { characterId: 'mika' })
    const reparsed = parseMemoryMarkdown(text)

    // Same count.
    expect(reparsed.length).toBe(facts.length)
    // Every input fact appears by id.
    const byId = new Map(reparsed.map((f) => [f.id, f]))
    for (const original of facts) {
      const round = byId.get(original.id)
      expect(round).toBeDefined()
      if (!round) continue
      expect(round.content).toBe(original.content)
      expect(round.category).toBe(original.category)
      expect(round.importance).toBeCloseTo(original.importance, 2)
      expect(round.accessCount).toBe(original.accessCount)
      expect(round.lastAccessedAt).toBe(original.lastAccessedAt)
      expect(round.createdAt).toBe(original.createdAt)
      expect(round.compressionLevel).toBe(original.compressionLevel)
      expect(round.sourceMessageIds).toEqual(original.sourceMessageIds)
    }

    // Serializing again should be byte-equal (modulo sort order, which
    // the serializer enforces).
    const resaved = stringifyMemoryMarkdown(reparsed, { characterId: 'mika' })
    expect(resaved).toBe(text)
  })

  /**
   * @example file header carries character + user, and parseMemoryMarkdown
   * preserves them for downstream consumers.
   */
  it('preserves the file header', () => {
    const facts: MemoryFact[] = [
      makeFact({ id: 'f_a', content: 'Name: Alice', category: 'durable' }),
    ]
    const text = stringifyMemoryMarkdown(facts, {
      characterId: 'ani',
      userId: 'alice',
    })
    expect(text).toContain('<!-- memory-file-version: 1 -->')
    expect(text).toContain('<!-- character: ani -->')
    expect(text).toContain('<!-- user: alice -->')

    const reparsed = parseMemoryMarkdown(text)
    expect(reparsed[0].userId).toBe('alice')
    // parseMemoryMarkdown leaves characterId from the header; repo.load
    // overrides it. Either way, the header is round-tripped.
    expect(reparsed[0].characterId).toBe('ani')
  })

  /**
   * @example malformed lines don't crash the parser and don't pollute
   * the output.
   */
  it('skips malformed lines without throwing', () => {
    const text = [
      '<!-- memory-file-version: 1 -->',
      '<!-- character: mika -->',
      '',
      '## Durable',
      '',
      '- [f_ok] Valid fact (i:0.8 · acc:1 · seen:2026-04-21T00:00:00.000Z · L0 · cat:durable · created:2026-04-21T00:00:00.000Z)',
      'random text that should be ignored',
      '- missing brackets',
      '- [bad id style]?!',
      '',
      '## BogusSection',
      '- [f_orphan] orphan with unknown category',
      '',
      '## Preferences',
      '',
      '- [f_pref] A preference (cat:preference · i:0.5)',
      '',
    ].join('\n')

    const facts = parseMemoryMarkdown(text)
    expect(facts.find((f) => f.id === 'f_ok')).toBeDefined()
    expect(facts.find((f) => f.id === 'f_pref')).toBeDefined()
    // Orphaned fact falls through because "BogusSection" isn't a known
    // category heading and the line had no cat: metadata override.
    expect(facts.find((f) => f.id === 'f_orphan')).toBeUndefined()
    // No crash, no extra noise.
    expect(facts.length).toBe(2)
  })

  /**
   * @example an empty file yields an empty array.
   */
  it('returns [] for empty input', () => {
    expect(parseMemoryMarkdown('')).toEqual([])
    expect(parseMemoryMarkdown('   \n\n').length).toBe(0)
  })

  /**
   * @example content with parentheses is escaped so the metadata tail
   * detector doesn't bite into it.
   */
  it('handles content containing parentheses', () => {
    const facts: MemoryFact[] = [
      makeFact({
        id: 'f_parens',
        content: 'Prefers "foo (bar)" over baz',
        category: 'preference',
      }),
    ]
    const text = stringifyMemoryMarkdown(facts, { characterId: 'mika' })
    const reparsed = parseMemoryMarkdown(text)
    expect(reparsed[0].content).toBe('Prefers "foo (bar)" over baz')
  })
})
