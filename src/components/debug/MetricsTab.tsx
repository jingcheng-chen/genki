import { useMemo } from 'react'
import type { TraceEvent } from '../../observability/types'
import {
  percentiles,
  recentLatencies,
  recentTurnStages,
} from '../../observability/metrics'

/**
 * Phase 8 Metrics tab.
 *
 *  - Current fps + mini sparkline from `fps` events.
 *  - P50/P95 for each turn-level stage across the last 20 turns.
 *  - Stacked horizontal bar per recent turn: thinking (sky) /
 *    speaking gap (emerald) / playback tail (slate).
 */

interface Props {
  events: TraceEvent[]
}

const RECENT_WINDOW = 20
const FPS_SPARKLINE_POINTS = 30

export function MetricsTab({ events }: Props) {
  const fpsHistory = useMemo(() => {
    const out: number[] = []
    for (const ev of events) {
      if (ev.category !== 'fps') continue
      const d = ev.data as { fps?: number } | null
      if (d && typeof d.fps === 'number') out.push(d.fps)
    }
    return out.slice(-FPS_SPARKLINE_POINTS)
  }, [events])
  const currentFps = fpsHistory.length > 0 ? fpsHistory[fpsHistory.length - 1] : null

  const latencies = useMemo(
    () => recentLatencies(events, RECENT_WINDOW),
    [events],
  )
  const turns = useMemo(
    () => recentTurnStages(events, RECENT_WINDOW),
    [events],
  )

  const think = percentiles(latencies.llmFirstToken)
  const audio = percentiles(latencies.ttsFirstAudio)
  const total = percentiles(latencies.total)

  // Max total ms informs the bar chart scale.
  const maxMs = Math.max(
    1,
    ...turns.map((t) => t.stages.totalMs ?? 0),
  )

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-1">
      <div className="flex items-center gap-3">
        <div className="flex items-baseline gap-1">
          <span className="text-[10px] uppercase tracking-wider opacity-60">
            fps
          </span>
          <span className="font-mono text-lg">
            {currentFps === null ? '—' : currentFps.toFixed(0)}
          </span>
        </div>
        <FpsSparkline samples={fpsHistory} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <LatencyCard
          label="LLM first token"
          stats={think}
          colorClass="bg-sky-800"
        />
        <LatencyCard
          label="First audio"
          stats={audio}
          colorClass="bg-emerald-800"
        />
        <LatencyCard
          label="Turn total"
          stats={total}
          colorClass="bg-zinc-700"
        />
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-[10px] uppercase tracking-wider opacity-60">
          Last {turns.length} turns
        </div>
        {turns.length === 0 && (
          <div className="text-zinc-500">No completed turns yet.</div>
        )}
        {turns.map((t) => (
          <TurnBar key={t.turnId} maxMs={maxMs} turnId={t.turnId} stages={t.stages} />
        ))}
      </div>
    </div>
  )
}

function LatencyCard({
  label,
  stats,
  colorClass,
}: {
  label: string
  stats: { p50: number; p95: number; count: number }
  colorClass: string
}) {
  return (
    <div
      className={[
        'flex flex-col gap-0.5 rounded px-2 py-1.5 text-[11px]',
        colorClass,
      ].join(' ')}
    >
      <div className="text-[10px] uppercase tracking-wider opacity-80">
        {label} · n={stats.count}
      </div>
      <div className="flex items-baseline gap-2 font-mono">
        <span className="text-lg">
          {stats.count === 0 ? '—' : Math.round(stats.p50)}
        </span>
        <span className="text-[10px] opacity-80">p50</span>
        <span className="ml-2 text-lg">
          {stats.count === 0 ? '—' : Math.round(stats.p95)}
        </span>
        <span className="text-[10px] opacity-80">p95</span>
        <span className="ml-auto text-[10px] opacity-60">ms</span>
      </div>
    </div>
  )
}

function TurnBar({
  maxMs,
  turnId,
  stages,
}: {
  maxMs: number
  turnId: string
  stages: {
    llmFirstTokenMs: number | null
    ttsFirstAudioMs: number | null
    totalMs: number | null
  }
}) {
  const think = stages.llmFirstTokenMs ?? 0
  // "speaking" = time between first token and first audio (TTS latency
  // net of the think portion). Grey tail is the rest.
  const audioAt = stages.ttsFirstAudioMs ?? think
  const speaking = Math.max(0, audioAt - think)
  const total = stages.totalMs ?? audioAt
  const tail = Math.max(0, total - audioAt)

  const pct = (ms: number) => `${Math.min(100, (ms / maxMs) * 100)}%`

  return (
    <div className="flex items-center gap-2 font-mono text-[10px]">
      <span className="w-20 shrink-0 truncate opacity-60">
        {turnId.slice(-8)}
      </span>
      <div className="flex h-3 flex-1 overflow-hidden rounded bg-zinc-900">
        <div className="bg-sky-700" style={{ width: pct(think) }} />
        <div className="bg-emerald-700" style={{ width: pct(speaking) }} />
        <div className="bg-slate-600" style={{ width: pct(tail) }} />
      </div>
      <span className="w-12 shrink-0 tabular-nums text-right">
        {Math.round(total)}ms
      </span>
    </div>
  )
}

/**
 * Tiny inline sparkline for FPS. Renders as an SVG polyline — fits in
 * the header next to the numeric readout without needing a chart lib.
 */
function FpsSparkline({ samples }: { samples: number[] }) {
  if (samples.length < 2) {
    return <div className="h-4 w-24 rounded bg-zinc-900" />
  }
  const min = Math.min(...samples, 30)
  const max = Math.max(...samples, 60)
  const span = max - min || 1
  const w = 96
  const h = 16
  const step = w / (samples.length - 1)
  const points = samples
    .map((v, i) => {
      const x = i * step
      const y = h - ((v - min) / span) * (h - 2) - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      className="rounded bg-zinc-900"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        points={points}
        className="text-emerald-400"
      />
    </svg>
  )
}
