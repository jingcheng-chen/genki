import { useMemo, useState } from 'react'
import type { TraceEvent } from '../../observability/types'
import { computeTurnStages, listTurnIds } from '../../observability/metrics'

/**
 * Phase 8 Turns tab.
 *
 * Headline feature of the phase: per-turn, side-by-side view of the five
 * text-pipeline stages so the user can eyeball where "unnatural TTS"
 * was introduced.
 *
 * Column 1: raw LLM delta (what the model actually emitted on the wire)
 * Column 2: post-categorizer speech (reasoning tags stripped)
 * Column 3: post-marker literal (special markers split out)
 * Column 4: TTS chunker output (sentence-sized chunks)
 * Column 5: sanitized (post-emoji/HTML-strip, null if dropped)
 *
 * Word-level diff highlighting between adjacent columns surfaces what
 * was removed (rose) or looks different (amber). The user's eye is
 * drawn straight to the change, which is the whole point.
 */

interface Props {
  events: TraceEvent[]
}

interface TurnRow {
  turnId: string
  ts: number
  userText: string
  characterId: string
  stages: ReturnType<typeof computeTurnStages>
}

export function TurnsTab({ events }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null)

  const turns = useMemo<TurnRow[]>(() => {
    const ids = listTurnIds(events)
    // Newest first — users care about the reply they just heard.
    return ids
      .map((turnId) => {
        const startEv = events.find(
          (e) => e.turnId === turnId && e.category === 'turn.start',
        )
        const data = (startEv?.data ?? {}) as {
          userText?: string
          characterId?: string
        }
        return {
          turnId,
          ts: startEv?.ts ?? 0,
          userText: data.userText ?? '',
          characterId: data.characterId ?? '?',
          stages: computeTurnStages(events, turnId),
        }
      })
      .reverse()
  }, [events])

  if (turns.length === 0) {
    return (
      <div className="p-2 text-zinc-500">
        No turns yet. Send a message from the chat panel to populate this view.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto">
      {turns.map((t) => (
        <TurnCard
          key={t.turnId}
          turn={t}
          events={events}
          open={expanded === t.turnId}
          onToggle={() =>
            setExpanded((v) => (v === t.turnId ? null : t.turnId))
          }
        />
      ))}
    </div>
  )
}

function TurnCard({
  turn,
  events,
  open,
  onToggle,
}: {
  turn: TurnRow
  events: TraceEvent[]
  open: boolean
  onToggle: () => void
}) {
  const time = new Date(turn.ts).toLocaleTimeString()

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-zinc-800/50"
      >
        <span className="font-mono text-[11px] opacity-60">{time}</span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
          {turn.characterId}
        </span>
        <span className="flex-1 truncate text-zinc-100">
          {turn.userText || <span className="opacity-50">(no user text)</span>}
        </span>
        <StageBadges stages={turn.stages} />
        <span className="text-[10px] opacity-50">{open ? '▾' : '▸'}</span>
      </button>
      {open && <TurnPipeline turnId={turn.turnId} events={events} />}
    </div>
  )
}

function StageBadges({
  stages,
}: {
  stages: ReturnType<typeof computeTurnStages>
}) {
  return (
    <div className="flex gap-1 font-mono text-[10px]">
      <Badge label="think" ms={stages.llmFirstTokenMs} color="bg-sky-700" />
      <Badge label="audio" ms={stages.ttsFirstAudioMs} color="bg-emerald-700" />
      <Badge label="total" ms={stages.totalMs} color="bg-zinc-700" />
    </div>
  )
}

function Badge({
  label,
  ms,
  color,
}: {
  label: string
  ms: number | null
  color: string
}) {
  return (
    <span
      className={[
        'rounded px-1 py-0.5',
        ms === null ? 'bg-zinc-800 opacity-40' : color,
      ].join(' ')}
    >
      {label} {ms === null ? '—' : `${ms}ms`}
    </span>
  )
}

/**
 * Assembles the five stage texts and renders them in a 5-column grid.
 * Each column shows a concatenation of the relevant trace events for
 * that turn, so you can see the chunking in action.
 */
function TurnPipeline({
  turnId,
  events,
}: {
  turnId: string
  events: TraceEvent[]
}) {
  // Pull each category's events in original order and render one
  // row per event so chunk boundaries stay visible.
  const rows = useMemo(() => buildStageRows(turnId, events), [turnId, events])
  const columns: Array<{ id: StageId; label: string; rows: string[] }> = [
    { id: 'raw', label: 'Raw LLM', rows: rows.raw },
    { id: 'categorizer', label: 'Post-think', rows: rows.categorizer },
    { id: 'marker', label: 'Post-marker', rows: rows.marker },
    { id: 'chunker', label: 'TTS chunks', rows: rows.chunker },
    { id: 'sanitized', label: 'Sanitized', rows: rows.sanitized },
  ]

  return (
    <div className="grid grid-cols-5 gap-1 border-t border-zinc-800 p-2">
      {columns.map((col, idx) => {
        const prev = idx > 0 ? columns[idx - 1].rows : null
        return (
          <StageColumn
            key={col.id}
            label={col.label}
            rows={col.rows}
            prevRows={prev}
          />
        )
      })}
    </div>
  )
}

function StageColumn({
  label,
  rows,
  prevRows,
}: {
  label: string
  rows: string[]
  prevRows: string[] | null
}) {
  // Concatenate to get a sense of what this stage "says". Helps when
  // chunks misalign across stages (e.g. 4 raw deltas → 2 chunker chunks).
  const concatThis = rows.join('')
  const concatPrev = prevRows?.join('') ?? ''
  const tokens = prevRows ? diffTokens(concatPrev, concatThis) : null

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wider opacity-60">
        {label} ({rows.length})
      </div>
      <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded bg-zinc-950/60 p-1 font-mono text-[11px]">
        {rows.length === 0 && (
          <div className="opacity-40">(empty — stage produced no output)</div>
        )}
        {rows.map((text, i) => (
          <div
            key={i}
            className={[
              'whitespace-pre-wrap break-words rounded px-1 py-0.5',
              text === '' ? 'bg-rose-900/60 italic text-rose-200' : 'bg-zinc-900',
            ].join(' ')}
          >
            {text === '' ? '(dropped)' : text}
          </div>
        ))}
        {tokens && rows.length > 0 && (
          <DiffLine tokens={tokens} />
        )}
      </div>
    </div>
  )
}

/**
 * Word-level set-difference between two concatenated stage strings.
 * Not a proper Myers diff — we just tokenize and flag words that
 * appear only in one side. Good enough to eyeball "wait, why is the
 * HTML tag only on the left?".
 */
function diffTokens(
  prev: string,
  curr: string,
): { removed: string[]; added: string[] } {
  const tok = (s: string) => s.split(/\s+/).filter(Boolean)
  const ps = new Set(tok(prev))
  const cs = new Set(tok(curr))
  const removed: string[] = []
  const added: string[] = []
  for (const t of ps) if (!cs.has(t)) removed.push(t)
  for (const t of cs) if (!ps.has(t)) added.push(t)
  return { removed, added }
}

function DiffLine({
  tokens,
}: {
  tokens: { removed: string[]; added: string[] }
}) {
  if (tokens.removed.length === 0 && tokens.added.length === 0) return null
  return (
    <div className="mt-1 border-t border-zinc-800 pt-1 text-[10px]">
      {tokens.removed.length > 0 && (
        <div className="text-rose-300">
          − {tokens.removed.slice(0, 6).join(' ')}
          {tokens.removed.length > 6 ? ` …(+${tokens.removed.length - 6})` : ''}
        </div>
      )}
      {tokens.added.length > 0 && (
        <div className="text-amber-300">
          + {tokens.added.slice(0, 6).join(' ')}
          {tokens.added.length > 6 ? ` …(+${tokens.added.length - 6})` : ''}
        </div>
      )}
    </div>
  )
}

type StageId = 'raw' | 'categorizer' | 'marker' | 'chunker' | 'sanitized'

interface StageRows {
  raw: string[]
  categorizer: string[]
  marker: string[]
  chunker: string[]
  sanitized: string[]
}

/**
 * Walks the event list once and buckets each event into the right
 * stage column. Empty-string entries in `sanitized` represent chunks
 * that the sanitizer dropped — we want those to show up visually.
 */
function buildStageRows(turnId: string, events: TraceEvent[]): StageRows {
  const out: StageRows = {
    raw: [],
    categorizer: [],
    marker: [],
    chunker: [],
    sanitized: [],
  }
  for (const ev of events) {
    if (ev.turnId !== turnId) continue
    switch (ev.category) {
      case 'llm.raw-delta': {
        const d = ev.data as { delta?: string }
        if (typeof d.delta === 'string') out.raw.push(d.delta)
        break
      }
      case 'categorizer.speech': {
        const d = ev.data as { text?: string }
        if (typeof d.text === 'string') out.categorizer.push(d.text)
        break
      }
      case 'marker.literal': {
        const d = ev.data as { text?: string }
        if (typeof d.text === 'string') out.marker.push(d.text)
        break
      }
      case 'ttsch.chunk': {
        const d = ev.data as { text?: string }
        if (typeof d.text === 'string') out.chunker.push(d.text)
        break
      }
      case 'tts.sanitize-out': {
        const d = ev.data as { text?: string | null }
        // Sanitizer may have returned null (dropped). Render as an empty
        // string marker so the column preserves index alignment and the
        // UI can highlight "dropped" rows.
        out.sanitized.push(typeof d.text === 'string' ? d.text : '')
        break
      }
    }
  }
  return out
}
