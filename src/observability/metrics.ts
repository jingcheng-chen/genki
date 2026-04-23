import type { TraceEvent } from './types'

/**
 * Phase 8 — pure helpers that derive dashboards from the tracer's event
 * ring. Zero DOM, zero React — consumed by `MetricsTab.tsx` and the
 * optional headless test harness.
 */

/** Per-turn stage timings computed from tracer events. */
export interface TurnStages {
  /** ms from `turn.start` to `llm.fetch-sent` — client-side fetch
   *  promise resolved; TCP + server-to-xAI handshake done. */
  llmFetchSentMs: number | null
  /** ms from `turn.start` to `llm.first-byte` — first Uint8Array off
   *  the Response body. Captures xAI prefill. */
  llmFirstByteMs: number | null
  /** ms from `turn.start` to `llm.first-token`. null if no first-token event. */
  llmFirstTokenMs: number | null
  /** ms from `turn.start` to `turn.first-audio`. null if no audio started. */
  ttsFirstAudioMs: number | null
  /** ms from `turn.start` to `turn.end`. null if the turn hasn't ended. */
  totalMs: number | null
}

/**
 * Computes the stage-latency breakdown for one turn.
 *
 * Use when:
 * - Rendering a per-turn bar on the Metrics tab.
 * - Asserting correctness of instrumentation in a test.
 *
 * Expects:
 * - `events` is the tracer snapshot (order-stable, newest or oldest first
 *   both acceptable — we scan and pick per category).
 * - `turnId` is the id emitted with `turn.start`.
 *
 * Returns:
 * - `{ llmFirstTokenMs, ttsFirstAudioMs, totalMs }`. Any missing stage is
 *   `null` rather than 0 so the UI can distinguish "not yet" from "0ms".
 *
 * @example
 *   computeTurnStages(events, 'turn_abc123')
 *   // → { llmFirstTokenMs: 840, ttsFirstAudioMs: 1620, totalMs: 4300 }
 */
export function computeTurnStages(
  events: TraceEvent[],
  turnId: string,
): TurnStages {
  let startTs: number | null = null
  let fetchSentMs: number | null = null
  let firstByteMs: number | null = null
  let firstTokenMs: number | null = null
  let firstAudioMs: number | null = null
  let totalMs: number | null = null

  for (const ev of events) {
    if (ev.turnId !== turnId) continue
    if (ev.category === 'turn.start') {
      startTs = ev.ts
    } else if (ev.category === 'llm.fetch-sent') {
      const d = ev.data as { elapsedMs?: number } | undefined
      if (d && typeof d.elapsedMs === 'number') fetchSentMs = d.elapsedMs
    } else if (ev.category === 'llm.first-byte') {
      const d = ev.data as { elapsedMs?: number } | undefined
      if (d && typeof d.elapsedMs === 'number') firstByteMs = d.elapsedMs
    } else if (ev.category === 'llm.first-token') {
      const d = ev.data as { ms?: number } | undefined
      if (d && typeof d.ms === 'number') firstTokenMs = d.ms
    } else if (ev.category === 'turn.first-audio') {
      const d = ev.data as { ms?: number } | undefined
      if (d && typeof d.ms === 'number') firstAudioMs = d.ms
    } else if (ev.category === 'turn.end') {
      const d = ev.data as { totalMs?: number } | undefined
      if (d && typeof d.totalMs === 'number') totalMs = d.totalMs
    }
  }

  // Fallback: if the typed payload was missing but we have timestamps,
  // derive from deltas. Keeps the UI robust to minor emit-site omissions.
  if (startTs !== null && totalMs === null) {
    const endEv = events.find(
      (e) => e.turnId === turnId && e.category === 'turn.end',
    )
    if (endEv) totalMs = endEv.ts - startTs
  }
  if (startTs !== null && fetchSentMs === null) {
    const ev = events.find(
      (e) => e.turnId === turnId && e.category === 'llm.fetch-sent',
    )
    if (ev) fetchSentMs = ev.ts - startTs
  }
  if (startTs !== null && firstByteMs === null) {
    const ev = events.find(
      (e) => e.turnId === turnId && e.category === 'llm.first-byte',
    )
    if (ev) firstByteMs = ev.ts - startTs
  }
  if (startTs !== null && firstTokenMs === null) {
    const ev = events.find(
      (e) => e.turnId === turnId && e.category === 'llm.first-token',
    )
    if (ev) firstTokenMs = ev.ts - startTs
  }
  if (startTs !== null && firstAudioMs === null) {
    const ev = events.find(
      (e) => e.turnId === turnId && e.category === 'turn.first-audio',
    )
    if (ev) firstAudioMs = ev.ts - startTs
  }

  return {
    llmFetchSentMs: fetchSentMs,
    llmFirstByteMs: firstByteMs,
    llmFirstTokenMs: firstTokenMs,
    ttsFirstAudioMs: firstAudioMs,
    totalMs,
  }
}

/**
 * Returns the list of distinct turn ids in the event stream, oldest
 * first. Used by the Turns tab to render the turn list.
 */
export function listTurnIds(events: TraceEvent[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const ev of events) {
    if (ev.category !== 'turn.start') continue
    if (!ev.turnId || seen.has(ev.turnId)) continue
    seen.add(ev.turnId)
    ids.push(ev.turnId)
  }
  return ids
}

/** P50 + P95 of a set of latencies. Sorted in place on a shallow copy. */
export interface LatencyStats {
  p50: number
  p95: number
  count: number
}

/**
 * Standard-textbook percentiles for a list of latency samples in ms.
 *
 * Use when:
 * - Rendering a P50/P95 chip on the Metrics tab.
 *
 * Expects:
 * - `samples` is a non-empty array of finite numbers. Empty input
 *   returns `{ p50: 0, p95: 0, count: 0 }`.
 *
 * Returns:
 * - `p50`, `p95`, and the sample count. Percentiles use linear
 *   interpolation so small sample sets don't snap to just one value.
 *
 * @example
 *   percentiles([100, 200, 300, 400, 500])
 *   // → { p50: 300, p95: 480, count: 5 }
 */
export function percentiles(samples: number[]): LatencyStats {
  if (samples.length === 0) return { p50: 0, p95: 0, count: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50: pick(sorted, 0.5),
    p95: pick(sorted, 0.95),
    count: sorted.length,
  }
}

function pick(sorted: number[], q: number): number {
  // Linear interpolation between two neighbours. Matches numpy's default.
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  const frac = pos - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

/**
 * Collects the last `N` completed turns' `TurnStages`, oldest first.
 *
 * Use when:
 * - Rendering the stacked-latency bar chart on the Metrics tab.
 */
export function recentTurnStages(
  events: TraceEvent[],
  limit = 20,
): Array<{ turnId: string; stages: TurnStages }> {
  const ids = listTurnIds(events)
  const tail = ids.slice(-limit)
  return tail.map((turnId) => ({ turnId, stages: computeTurnStages(events, turnId) }))
}

/**
 * Recent latencies across turns. Feeds `percentiles` for the Metrics tab.
 */
export function recentLatencies(
  events: TraceEvent[],
  limit = 20,
): {
  llmFetchSent: number[]
  llmFirstByte: number[]
  llmFirstToken: number[]
  ttsFirstAudio: number[]
  total: number[]
} {
  const all = recentTurnStages(events, limit)
  return {
    llmFetchSent: all
      .map((r) => r.stages.llmFetchSentMs)
      .filter((n): n is number => n !== null),
    llmFirstByte: all
      .map((r) => r.stages.llmFirstByteMs)
      .filter((n): n is number => n !== null),
    llmFirstToken: all
      .map((r) => r.stages.llmFirstTokenMs)
      .filter((n): n is number => n !== null),
    ttsFirstAudio: all
      .map((r) => r.stages.ttsFirstAudioMs)
      .filter((n): n is number => n !== null),
    total: all
      .map((r) => r.stages.totalMs)
      .filter((n): n is number => n !== null),
  }
}
