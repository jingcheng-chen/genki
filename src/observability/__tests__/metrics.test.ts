import { describe, expect, it } from 'vitest'
import {
  computeTurnStages,
  listTurnIds,
  percentiles,
  recentTurnStages,
} from '../metrics'
import type { TraceEvent, TraceCategory } from '../types'

/**
 * Build a synthetic event. Default `turnId` is null; override as needed.
 *
 * @example
 *   ev('turn.start', { userText: 'hi' }, 't1', 0)
 */
function ev(
  category: TraceCategory,
  data: unknown,
  turnId: string | null,
  ts: number,
  seq = 0,
): TraceEvent {
  return { seq, ts, category, data, turnId }
}

describe('computeTurnStages', () => {
  /**
   * @example
   *   given turn.start@100, llm.first-token@940, turn.first-audio@1720,
   *   turn.end@4400 → {840, 1620, 4300}
   */
  it('returns the three stage timings from a hand-built event list', () => {
    const events: TraceEvent[] = [
      ev('turn.start', { userText: 'hi' }, 't1', 100),
      ev('llm.first-token', { ms: 840 }, 't1', 940),
      ev('turn.first-audio', { ms: 1620 }, 't1', 1720),
      ev('turn.end', { totalMs: 4300 }, 't1', 4400),
    ]
    const stages = computeTurnStages(events, 't1')
    expect(stages.llmFirstTokenMs).toBe(840)
    expect(stages.ttsFirstAudioMs).toBe(1620)
    expect(stages.totalMs).toBe(4300)
  })

  /**
   * @example
   *   llm.fetch-sent@180 + llm.first-byte@780 are picked up as their own
   *   fields — needed for the Metrics tab's "network / prefill / decode"
   *   split.
   */
  it('exposes fetch-sent and first-byte as separate stage spans', () => {
    const events: TraceEvent[] = [
      ev('turn.start', { userText: 'hi' }, 't1', 100),
      ev('llm.fetch-sent', { elapsedMs: 80 }, 't1', 180),
      ev('llm.first-byte', { elapsedMs: 680 }, 't1', 780),
      ev('llm.first-token', { ms: 740 }, 't1', 840),
      ev('turn.end', { totalMs: 4300 }, 't1', 4400),
    ]
    const stages = computeTurnStages(events, 't1')
    expect(stages.llmFetchSentMs).toBe(80)
    expect(stages.llmFirstByteMs).toBe(680)
    expect(stages.llmFirstTokenMs).toBe(740)
  })

  /**
   * @example
   *   events for another turn are ignored.
   */
  it('ignores events from other turns', () => {
    const events: TraceEvent[] = [
      ev('turn.start', { userText: 'hi' }, 't1', 100),
      ev('turn.start', { userText: 'again' }, 't2', 200),
      ev('llm.first-token', { ms: 300 }, 't2', 500),
      ev('turn.end', { totalMs: 999 }, 't2', 1199),
    ]
    const stages = computeTurnStages(events, 't1')
    expect(stages.llmFirstTokenMs).toBeNull()
    expect(stages.ttsFirstAudioMs).toBeNull()
    expect(stages.totalMs).toBeNull()
  })

  /**
   * @example
   *   missing ms in payload → fall back to ts delta from turn.start.
   */
  it('falls back to ts deltas if ms field is missing', () => {
    const events: TraceEvent[] = [
      ev('turn.start', { userText: 'hi' }, 't1', 100),
      ev('llm.first-token', {}, 't1', 900),
      ev('turn.first-audio', {}, 't1', 1700),
      ev('turn.end', {}, 't1', 4500),
    ]
    const stages = computeTurnStages(events, 't1')
    expect(stages.llmFirstTokenMs).toBe(800)
    expect(stages.ttsFirstAudioMs).toBe(1600)
    expect(stages.totalMs).toBe(4400)
  })

  /**
   * @example
   *   unfinished turn → totalMs is null; earlier stages still present.
   */
  it('returns null for stages that have not happened yet', () => {
    const events: TraceEvent[] = [
      ev('turn.start', { userText: 'hi' }, 't1', 100),
      ev('llm.first-token', { ms: 800 }, 't1', 900),
    ]
    const stages = computeTurnStages(events, 't1')
    expect(stages.llmFirstTokenMs).toBe(800)
    expect(stages.ttsFirstAudioMs).toBeNull()
    expect(stages.totalMs).toBeNull()
    // Network-phase fields are also absent for a turn that never got
    // its fetch promise resolved.
    expect(stages.llmFetchSentMs).toBeNull()
    expect(stages.llmFirstByteMs).toBeNull()
  })
})

describe('listTurnIds', () => {
  /**
   * @example
   *   returns distinct ids in the order they first appear.
   */
  it('returns distinct turn ids in event order', () => {
    const events: TraceEvent[] = [
      ev('turn.start', {}, 't1', 100),
      ev('llm.raw-delta', {}, 't1', 200),
      ev('turn.start', {}, 't2', 300),
      ev('turn.end', {}, 't1', 400),
      ev('turn.start', {}, 't3', 500),
    ]
    expect(listTurnIds(events)).toEqual(['t1', 't2', 't3'])
  })
})

describe('percentiles', () => {
  /**
   * @example
   *   percentiles([100, 200, 300, 400, 500]) → p50=300, p95=480
   */
  it('computes p50 / p95 with linear interpolation', () => {
    const out = percentiles([100, 200, 300, 400, 500])
    expect(out.count).toBe(5)
    expect(out.p50).toBe(300)
    // 95th percentile of 5 samples: pos = 4 * 0.95 = 3.8 → between 400 and 500 → 480.
    expect(out.p95).toBeCloseTo(480, 5)
  })

  /**
   * @example
   *   single-sample input — p50 and p95 both equal the sample.
   */
  it('handles a one-element list without NaN', () => {
    const out = percentiles([42])
    expect(out.p50).toBe(42)
    expect(out.p95).toBe(42)
    expect(out.count).toBe(1)
  })

  /**
   * @example
   *   empty → zero stats (UI treats count=0 as "no data").
   */
  it('returns zeros for empty input', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, count: 0 })
  })
})

describe('recentTurnStages', () => {
  /**
   * @example
   *   with three completed turns and a limit of 2, returns the last two
   *   in oldest→newest order.
   */
  it('keeps only the last N turns, oldest first', () => {
    const events: TraceEvent[] = [
      ev('turn.start', {}, 't1', 0),
      ev('turn.end', { totalMs: 100 }, 't1', 100),
      ev('turn.start', {}, 't2', 200),
      ev('turn.end', { totalMs: 150 }, 't2', 350),
      ev('turn.start', {}, 't3', 400),
      ev('turn.end', { totalMs: 300 }, 't3', 700),
    ]
    const out = recentTurnStages(events, 2)
    expect(out.map((r) => r.turnId)).toEqual(['t2', 't3'])
    expect(out[0].stages.totalMs).toBe(150)
    expect(out[1].stages.totalMs).toBe(300)
  })
})
