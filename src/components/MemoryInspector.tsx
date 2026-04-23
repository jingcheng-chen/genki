import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCharacterStore } from '../stores/character'
import { clearFacts, loadFacts } from '../memory/repo'
import { retentionScore } from '../memory/decay'
import type { Category, MemoryFact } from '../types/memory'

/**
 * Memory inspector — bottom-left, dev-only. Mirrors CharacterPicker's
 * visual style (same width, backdrop blur, collapsible button row).
 *
 * Shows:
 *  - All facts for the active character, grouped by category.
 *  - Retention bar (red → green) + compression level badge + access count.
 *  - Refresh button (reloads from IndexedDB).
 *  - Clear memory button (confirms then wipes the character's file).
 *
 * Subscribes to the character store so switching characters reloads.
 */
const CATEGORY_ORDER: Category[] = [
  'durable',
  'relational',
  'preference',
  'emotional',
  'episodic',
]

const CATEGORY_LABEL: Record<Category, string> = {
  durable: 'Durable',
  relational: 'Relational',
  preference: 'Preferences',
  emotional: 'Emotional',
  episodic: 'Episodic',
}

export function MemoryInspector() {
  const activePresetId = useCharacterStore((s) => s.activePresetId)
  const [expanded, setExpanded] = useState(false)
  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [loadedAt, setLoadedAt] = useState<number>(() => Date.now())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const next = await loadFacts(id)
      setFacts(next)
      setLoadedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload(activePresetId)
  }, [activePresetId, reload])

  const grouped = useMemo(() => {
    const by = new Map<Category, MemoryFact[]>()
    for (const cat of CATEGORY_ORDER) by.set(cat, [])
    for (const f of facts) {
      const bucket = by.get(f.category)
      if (bucket) bucket.push(f)
    }
    for (const bucket of by.values()) {
      bucket.sort((a, b) => b.importance - a.importance)
    }
    return by
  }, [facts])

  async function handleClear() {
    // Plain confirm; it's a dev panel, no need for a fancy dialog.
    if (!window.confirm(`Clear all memory for "${activePresetId}"?`)) return
    try {
      await clearFacts(activePresetId)
      await reload(activePresetId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const total = facts.length

  return (
    <div
      className={[
        'pointer-events-auto absolute bottom-4 left-4 flex w-72 flex-col gap-2',
        'rounded-lg bg-black/60 p-3 text-sm text-zinc-100 backdrop-blur-sm',
      ].join(' ')}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-left"
      >
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider opacity-60">
            Memory · {activePresetId}
          </span>
          <span className="font-semibold">
            {total} fact{total === 1 ? '' : 's'}
          </span>
        </div>
        <span className="ml-auto text-xs opacity-60">
          {expanded ? 'v' : '^'}
        </span>
      </button>

      {expanded && (
        <>
          <div className="flex gap-2">
            <button
              onClick={() => void reload(activePresetId)}
              disabled={loading}
              className={[
                'flex-1 rounded bg-zinc-800 px-2 py-1 text-[11px] uppercase tracking-wider',
                'hover:bg-zinc-700 disabled:opacity-50',
              ].join(' ')}
            >
              {loading ? 'Loading' : 'Refresh'}
            </button>
            <button
              onClick={() => void handleClear()}
              disabled={loading || total === 0}
              className={[
                'rounded bg-rose-800 px-2 py-1 text-[11px] uppercase tracking-wider text-rose-50',
                'hover:bg-rose-700 disabled:opacity-40',
              ].join(' ')}
            >
              Clear
            </button>
          </div>

          {error && (
            <div className="break-words text-[11px] text-rose-400">{error}</div>
          )}

          <div className="flex max-h-72 flex-col gap-2 overflow-y-auto rounded bg-zinc-950/60 p-2 text-[11px]">
            {total === 0 && (
              <div className="opacity-50">
                No facts yet. Chat with {activePresetId} and memory will grow.
              </div>
            )}
            {CATEGORY_ORDER.map((cat) => {
              const bucket = grouped.get(cat) ?? []
              if (bucket.length === 0) return null
              return (
                <CategoryBlock
                  key={cat}
                  label={CATEGORY_LABEL[cat]}
                  facts={bucket}
                  now={loadedAt}
                />
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function CategoryBlock({
  label,
  facts,
  now,
}: {
  label: string
  facts: MemoryFact[]
  now: number
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wider opacity-60">
        {label} ({facts.length})
      </div>
      {facts.map((f) => (
        <FactRow key={f.id} fact={f} now={now} />
      ))}
    </div>
  )
}

function FactRow({ fact, now }: { fact: MemoryFact; now: number }) {
  const retention = retentionScore(fact, new Date(now))
  const pct = Math.max(0, Math.min(1, retention))
  return (
    <div className="flex flex-col gap-0.5 rounded bg-zinc-900/60 px-2 py-1">
      <div className="break-words">{fact.content}</div>
      <div className="flex items-center gap-2 text-[10px] opacity-70">
        <span className="rounded bg-zinc-800 px-1 py-[1px]">
          L{fact.compressionLevel}
        </span>
        <span>i {fact.importance.toFixed(2)}</span>
        <span>acc {fact.accessCount}</span>
        <RetentionBar pct={pct} />
        <span className="tabular-nums">{Math.round(pct * 100)}%</span>
      </div>
    </div>
  )
}

function RetentionBar({ pct }: { pct: number }) {
  // Red at 0, amber mid, emerald high. A subtle gradient tells you at a
  // glance which facts will compact / drop next.
  const hue = Math.round(pct * 120)
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-800">
      <div
        className="h-full"
        style={{
          width: `${pct * 100}%`,
          backgroundColor: `hsl(${hue} 70% 45%)`,
        }}
      />
    </div>
  )
}
