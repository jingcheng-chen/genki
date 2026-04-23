import { describe, it, expect } from 'vitest'
import { computeStability, rankFacts, retentionScore } from '../decay'
import type { MemoryFact, Category } from '../../types/memory'
import { CATEGORY_BASE_STABILITY } from '../../types/memory'

/**
 * Builds a minimal fact for math-only tests.
 *
 * @example
 *   const f = makeFact({ category: 'episodic', importance: 0.5 })
 */
function makeFact(patch: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: patch.id ?? 'f_test',
    characterId: 'mika',
    userId: 'local',
    content: 'placeholder',
    category: patch.category ?? 'episodic',
    createdAt: patch.createdAt ?? new Date('2026-04-21T00:00:00Z').toISOString(),
    lastAccessedAt:
      patch.lastAccessedAt ?? new Date('2026-04-21T00:00:00Z').toISOString(),
    accessCount: patch.accessCount ?? 0,
    importance: patch.importance ?? 0.5,
    compressionLevel: patch.compressionLevel ?? 0,
    sourceMessageIds: patch.sourceMessageIds ?? [],
    ...patch,
  }
}

describe('retentionScore', () => {
  /**
   * @example retention(t=0) === 1 — freshly-accessed fact has full recall.
   */
  it('returns 1 at t=0 regardless of category or importance', () => {
    const now = new Date('2026-04-21T00:00:00Z')
    const categories: Category[] = [
      'durable',
      'relational',
      'preference',
      'emotional',
      'episodic',
    ]
    for (const category of categories) {
      const fact = makeFact({ category, lastAccessedAt: now.toISOString() })
      expect(retentionScore(fact, now)).toBeCloseTo(1, 6)
    }
  })

  /**
   * @example
   *   an episodic fact seen 72h ago with importance 0 and acc 0 has
   *   retention ≈ 1/e.
   */
  it('decays exp(-t/S) for a baseline episodic fact', () => {
    const lastAccessedAt = new Date('2026-04-18T00:00:00Z').toISOString()
    const now = new Date('2026-04-21T00:00:00Z') // 72 hours later
    const fact = makeFact({
      category: 'episodic',
      importance: 0,
      accessCount: 0,
      lastAccessedAt,
    })
    const stability = computeStability(fact)
    expect(stability).toBeCloseTo(CATEGORY_BASE_STABILITY.episodic, 6)
    // 72h elapsed / 72h stability = 1 → e^-1
    expect(retentionScore(fact, now)).toBeCloseTo(Math.exp(-1), 6)
  })

  /**
   * @example durable facts shouldn't appreciably decay over a year.
   */
  it('durable facts retain > 0.99 after 30 days', () => {
    const lastAccessedAt = new Date('2026-03-21T00:00:00Z').toISOString()
    const now = new Date('2026-04-21T00:00:00Z') // +31 days
    const fact = makeFact({ category: 'durable', lastAccessedAt })
    expect(retentionScore(fact, now)).toBeGreaterThan(0.99)
  })
})

describe('computeStability', () => {
  /**
   * @example stability is strictly increasing in importance.
   */
  it('grows monotonically with importance', () => {
    const low = computeStability(makeFact({ importance: 0.1 }))
    const mid = computeStability(makeFact({ importance: 0.5 }))
    const high = computeStability(makeFact({ importance: 0.9 }))
    expect(mid).toBeGreaterThan(low)
    expect(high).toBeGreaterThan(mid)
  })

  /**
   * @example each recall bumps stability (but less and less each time).
   */
  it('grows monotonically with accessCount', () => {
    const s0 = computeStability(makeFact({ accessCount: 0 }))
    const s1 = computeStability(makeFact({ accessCount: 1 }))
    const s5 = computeStability(makeFact({ accessCount: 5 }))
    const s50 = computeStability(makeFact({ accessCount: 50 }))
    expect(s1).toBeGreaterThan(s0)
    expect(s5).toBeGreaterThan(s1)
    expect(s50).toBeGreaterThan(s5)
  })

  /**
   * @example categories establish a clear floor: durable > relational >
   * preference > emotional > episodic.
   */
  it('respects the CATEGORY_BASE_STABILITY ordering', () => {
    const categories: Category[] = [
      'durable',
      'relational',
      'preference',
      'emotional',
      'episodic',
    ]
    const stabilities = categories.map((category) =>
      computeStability(makeFact({ category, importance: 0, accessCount: 0 })),
    )
    expect(stabilities[0]).toBe(CATEGORY_BASE_STABILITY.durable)
    expect(stabilities[1]).toBe(CATEGORY_BASE_STABILITY.relational)
    expect(stabilities[2]).toBe(CATEGORY_BASE_STABILITY.preference)
    expect(stabilities[3]).toBe(CATEGORY_BASE_STABILITY.emotional)
    expect(stabilities[4]).toBe(CATEGORY_BASE_STABILITY.episodic)
    // And the ordering durable > relational > preference > emotional > episodic.
    for (let i = 0; i < stabilities.length - 1; i++) {
      expect(stabilities[i]).toBeGreaterThan(stabilities[i + 1])
    }
  })

  /**
   * @example out-of-range importance is clamped rather than blowing up.
   */
  it('clamps importance to [0, 1]', () => {
    const low = computeStability(makeFact({ importance: -10 }))
    const normLow = computeStability(makeFact({ importance: 0 }))
    const high = computeStability(makeFact({ importance: 50 }))
    const normHigh = computeStability(makeFact({ importance: 1 }))
    expect(low).toBeCloseTo(normLow, 6)
    expect(high).toBeCloseTo(normHigh, 6)
  })
})

describe('rankFacts', () => {
  /**
   * @example high-importance + recent beats low-importance + old.
   */
  it('orders by importance * retention, low-importance beats decayed mid', () => {
    const now = new Date('2026-04-21T00:00:00Z')
    // Small importance but freshly accessed: score 0.3
    const freshLow = makeFact({
      id: 'f_c',
      importance: 0.3,
      lastAccessedAt: now.toISOString(),
    })
    // Higher importance but VERY old (importance bump isn't enough).
    // 10000h ago on a baseline-72h episodic with importance 0.4 gives
    // stability 72 * (1 + 4*0.4) = 187.2h → retention e^-53.4 ≈ 0.
    const stale = makeFact({
      id: 'f_b',
      importance: 0.4,
      lastAccessedAt: new Date(now.getTime() - 10_000 * 3.6e6).toISOString(),
    })
    // Top-ranked: high importance + fresh.
    const fresh = makeFact({
      id: 'f_a',
      importance: 0.9,
      lastAccessedAt: now.toISOString(),
    })
    const ranked = rankFacts([stale, freshLow, fresh], now)
    expect(ranked[0].id).toBe('f_a')
    expect(ranked[1].id).toBe('f_c')
    expect(ranked[2].id).toBe('f_b')
  })

  /**
   * @example sorting is stable under identical scores — use accessCount
   * and then id as tiebreakers.
   */
  it('tiebreaks on accessCount then id', () => {
    const now = new Date('2026-04-21T00:00:00Z')
    const a = makeFact({
      id: 'f_a',
      importance: 0.5,
      accessCount: 1,
      lastAccessedAt: now.toISOString(),
    })
    const b = makeFact({
      id: 'f_b',
      importance: 0.5,
      accessCount: 3,
      lastAccessedAt: now.toISOString(),
    })
    const c = makeFact({
      id: 'f_c',
      importance: 0.5,
      accessCount: 3,
      lastAccessedAt: now.toISOString(),
    })
    const ranked = rankFacts([a, c, b], now)
    expect(ranked.map((f) => f.id)).toEqual(['f_b', 'f_c', 'f_a'])
  })
})
