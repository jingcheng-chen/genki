import { useMemo, useState } from 'react'
import type { TraceEvent } from '../../observability/types'
import { TRACE_CATEGORIES } from '../../observability/types'

/**
 * Phase 8 Trace tab.
 *
 * Live event feed, newest-first. Filters:
 *  - Category chips: toggle whole categories on/off.
 *  - Search box: substring match against the JSON-stringified `data`.
 *
 * Each row renders a single line; click to expand the JSON payload
 * inline. No virtualisation — the ring is capped at 1000 events so
 * a naive map is fine.
 */

interface Props {
  events: TraceEvent[]
}

/**
 * Category prefixes used for chip grouping. We group by the part before
 * the dot (e.g. 'llm.*', 'tts.*', 'memory.*') so the filter bar stays
 * short and scanable.
 */
const CATEGORY_GROUPS = Array.from(
  new Set(TRACE_CATEGORIES.map((c) => c.split('.')[0])),
)

export function TraceTab({ events }: Props) {
  const [search, setSearch] = useState('')
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(CATEGORY_GROUPS),
  )
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return events
      .filter((ev) => enabled.has(ev.category.split('.')[0]))
      .filter((ev) => {
        if (!q) return true
        const hay = `${ev.category} ${JSON.stringify(ev.data)}`.toLowerCase()
        return hay.includes(q)
      })
      .slice()
      .reverse()
  }, [events, enabled, search])

  function toggleGroup(g: string) {
    setEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g)
      else next.add(g)
      return next
    })
  }

  function toggleRow(seq: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {CATEGORY_GROUPS.map((g) => (
          <button
            key={g}
            onClick={() => toggleGroup(g)}
            className={[
              'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
              enabled.has(g)
                ? 'bg-cyan-700 text-white'
                : 'bg-zinc-800 text-zinc-400',
            ].join(' ')}
          >
            {g}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="ml-auto w-48 rounded bg-zinc-900 px-2 py-0.5 text-[11px] ring-1 ring-zinc-700 focus:ring-cyan-500"
        />
        <span className="text-[10px] opacity-60">
          {filtered.length}/{events.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto rounded bg-zinc-950/60 p-1 font-mono text-[11px]">
        {filtered.length === 0 && (
          <div className="p-2 text-zinc-500">No events match the filter.</div>
        )}
        {filtered.map((ev) => (
          <TraceRow
            key={ev.seq}
            ev={ev}
            open={expanded.has(ev.seq)}
            onToggle={() => toggleRow(ev.seq)}
          />
        ))}
      </div>
    </div>
  )
}

function TraceRow({
  ev,
  open,
  onToggle,
}: {
  ev: TraceEvent
  open: boolean
  onToggle: () => void
}) {
  const summary = summarize(ev)
  return (
    <div className="border-b border-zinc-900/50 last:border-b-0">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-1 py-0.5 text-left hover:bg-zinc-800/50"
      >
        <span className="w-12 shrink-0 text-right tabular-nums text-zinc-500">
          {ev.seq}
        </span>
        <span className="w-16 shrink-0 tabular-nums text-zinc-500">
          {new Date(ev.ts).toLocaleTimeString('en-GB')}
        </span>
        <span
          className={[
            'w-32 shrink-0 rounded px-1 py-0.5 text-[10px] uppercase tracking-wider',
            categoryColor(ev.category),
          ].join(' ')}
        >
          {ev.category}
        </span>
        {ev.turnId && (
          <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">
            {ev.turnId.slice(-6)}
          </span>
        )}
        <span className="flex-1 truncate text-zinc-200">{summary}</span>
      </button>
      {open && (
        <pre className="ml-14 overflow-x-auto whitespace-pre-wrap break-words rounded bg-zinc-900 px-2 py-1 text-[10px] text-zinc-300">
          {JSON.stringify(ev.data, null, 2)}
        </pre>
      )}
    </div>
  )
}

/**
 * One-line summary of the event's most-interesting field so the trace
 * list stays scannable without having to expand every row.
 */
function summarize(ev: TraceEvent): string {
  const d = ev.data as Record<string, unknown> | null | undefined
  if (!d || typeof d !== 'object') return ''
  for (const key of ['text', 'delta', 'message', 'raw']) {
    const v = (d as Record<string, unknown>)[key]
    if (typeof v === 'string') return truncate(v, 80)
  }
  if ('fps' in d) return `fps ${d.fps} · frame ${d.frameMs}ms`
  if ('samples' in d) return `${d.samples} samples`
  if ('ms' in d) return `${d.ms}ms`
  try {
    return truncate(JSON.stringify(d), 80)
  } catch {
    return ''
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

function categoryColor(cat: string): string {
  const g = cat.split('.')[0]
  switch (g) {
    case 'llm':
      return 'bg-sky-900 text-sky-200'
    case 'categorizer':
      return 'bg-violet-900 text-violet-200'
    case 'marker':
      return 'bg-purple-900 text-purple-200'
    case 'ttsch':
      return 'bg-teal-900 text-teal-200'
    case 'tts':
      return 'bg-emerald-900 text-emerald-200'
    case 'stt':
      return 'bg-amber-900 text-amber-200'
    case 'vad':
      return 'bg-orange-900 text-orange-200'
    case 'anim':
      return 'bg-pink-900 text-pink-200'
    case 'memory':
      return 'bg-indigo-900 text-indigo-200'
    case 'turn':
      return 'bg-cyan-900 text-cyan-200'
    case 'fps':
      return 'bg-zinc-800 text-zinc-300'
    default:
      return 'bg-zinc-800 text-zinc-300'
  }
}
