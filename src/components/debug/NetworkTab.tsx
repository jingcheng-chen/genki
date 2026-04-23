import { useMemo } from 'react'
import type { TraceEvent } from '../../observability/types'

/**
 * Phase 8 Network tab.
 *
 * Derives an HTTP-ish request table from the tracer events. We don't
 * intercept `fetch` — instead, pipeline-stage events (`llm.request`,
 * `tts.request`, etc.) are paired with their nearest completion event
 * to show duration and status.
 *
 * Columns: timestamp · method · path · status · duration · summary.
 */

interface Props {
  events: TraceEvent[]
}

interface NetRow {
  seq: number
  ts: number
  method: string
  path: string
  status: string
  durationMs: number | null
  summary: string
}

export function NetworkTab({ events }: Props) {
  const rows = useMemo(() => buildNetworkRows(events), [events])

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wider opacity-60">
        Derived request log · {rows.length} entries
      </div>
      <div className="flex-1 overflow-y-auto rounded bg-zinc-950/60 p-1 font-mono text-[11px]">
        {rows.length === 0 && (
          <div className="p-2 text-zinc-500">No requests recorded yet.</div>
        )}
        {rows.length > 0 && (
          <div className="grid grid-cols-[6ch_7ch_4ch_16ch_7ch_7ch_1fr] gap-x-2 px-1 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <span>seq</span>
            <span>time</span>
            <span>meth</span>
            <span>path</span>
            <span>status</span>
            <span className="text-right">ms</span>
            <span>summary</span>
          </div>
        )}
        {rows.slice().reverse().map((r) => (
          <div
            key={r.seq}
            className="grid grid-cols-[6ch_7ch_4ch_16ch_7ch_7ch_1fr] gap-x-2 border-b border-zinc-900/40 px-1 py-0.5 last:border-b-0"
          >
            <span className="tabular-nums text-zinc-500">{r.seq}</span>
            <span className="tabular-nums text-zinc-500">
              {new Date(r.ts).toLocaleTimeString('en-GB')}
            </span>
            <span className="text-zinc-300">{r.method}</span>
            <span className="truncate text-zinc-200">{r.path}</span>
            <span
              className={
                r.status === 'err'
                  ? 'text-rose-300'
                  : r.status === 'ok'
                    ? 'text-emerald-300'
                    : 'text-zinc-400'
              }
            >
              {r.status}
            </span>
            <span className="text-right tabular-nums text-zinc-300">
              {r.durationMs === null ? '—' : Math.round(r.durationMs)}
            </span>
            <span className="truncate text-zinc-400">{r.summary}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Pair up request events with completion events to estimate duration.
 *
 * - llm.request      matched by llm.stream-end (same turnId) or error
 * - tts.request      matched by tts.audio-ready (same text) or error
 * - stt.request      matched by stt.response (same turnId) or error
 * - memory.extract-req matched by memory.extract-res
 * - memory.compact-req matched by memory.compact-res (same factId)
 */
function buildNetworkRows(events: TraceEvent[]): NetRow[] {
  const rows: NetRow[] = []

  for (const ev of events) {
    switch (ev.category) {
      case 'llm.request': {
        const done = events.find(
          (e) =>
            e.seq > ev.seq &&
            e.turnId === ev.turnId &&
            (e.category === 'llm.stream-end' || e.category === 'llm.error'),
        )
        rows.push({
          seq: ev.seq,
          ts: ev.ts,
          method: 'POST',
          path: '/api/chat',
          status: statusFor(done, 'llm.stream-end'),
          durationMs: done ? done.ts - ev.ts : null,
          summary: llmSummary(ev.data),
        })
        break
      }
      case 'tts.request': {
        const reqText = (ev.data as { text?: string }).text ?? ''
        const done = events.find(
          (e) =>
            e.seq > ev.seq &&
            (e.category === 'tts.audio-ready' || e.category === 'tts.error') &&
            (e.data as { text?: string } | undefined)?.text === reqText,
        )
        rows.push({
          seq: ev.seq,
          ts: ev.ts,
          method: 'POST',
          path: '/api/tts',
          status: statusFor(done, 'tts.audio-ready'),
          durationMs: done ? done.ts - ev.ts : null,
          summary: truncate(reqText, 80),
        })
        break
      }
      case 'stt.request': {
        const done = events.find(
          (e) =>
            e.seq > ev.seq &&
            (e.category === 'stt.response' || e.category === 'stt.error'),
        )
        rows.push({
          seq: ev.seq,
          ts: ev.ts,
          method: 'POST',
          path: '/api/stt',
          status: statusFor(done, 'stt.response'),
          durationMs: done ? done.ts - ev.ts : null,
          summary: `${(ev.data as { bytes?: number }).bytes ?? 0}B`,
        })
        break
      }
      case 'memory.extract-req': {
        const done = events.find(
          (e) =>
            e.seq > ev.seq &&
            (e.category === 'memory.extract-res' || e.category === 'memory.error'),
        )
        const res = done?.data as
          | { new?: number; reinforced?: number; outdated?: number }
          | undefined
        rows.push({
          seq: ev.seq,
          ts: ev.ts,
          method: 'POST',
          path: '/api/memory/extract',
          status: statusFor(done, 'memory.extract-res'),
          durationMs: done ? done.ts - ev.ts : null,
          summary: res
            ? `new=${res.new ?? 0} reinf=${res.reinforced ?? 0} out=${res.outdated ?? 0}`
            : '',
        })
        break
      }
      case 'memory.compact-req': {
        const reqFactId = (ev.data as { factId?: string }).factId
        const done = events.find(
          (e) =>
            e.seq > ev.seq &&
            ((e.category === 'memory.compact-res' &&
              (e.data as { factId?: string }).factId === reqFactId) ||
              e.category === 'memory.error'),
        )
        rows.push({
          seq: ev.seq,
          ts: ev.ts,
          method: 'POST',
          path: '/api/memory/compact',
          status: statusFor(done, 'memory.compact-res'),
          durationMs: done ? done.ts - ev.ts : null,
          summary: `fact=${reqFactId?.slice(-6) ?? '?'}`,
        })
        break
      }
    }
  }

  return rows
}

function statusFor(done: TraceEvent | undefined, okCategory: string): string {
  if (!done) return 'pending'
  return done.category === okCategory ? 'ok' : 'err'
}

function llmSummary(data: unknown): string {
  const d = data as
    | {
        messages?: Array<{ role: string; contentLen: number }>
        systemPromptLen?: number
      }
    | undefined
  if (!d) return ''
  const msgs = d.messages?.length ?? 0
  const sysLen = d.systemPromptLen ?? 0
  return `sys=${sysLen}c · msgs=${msgs}`
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}
