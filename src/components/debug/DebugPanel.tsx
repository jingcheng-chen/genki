import { useEffect, useState, useSyncExternalStore } from 'react'
import { tracer } from '../../observability/tracer'
import type { TraceEvent } from '../../observability/types'
import { TurnsTab } from './TurnsTab'
import { TraceTab } from './TraceTab'
import { MetricsTab } from './MetricsTab'
import { NetworkTab } from './NetworkTab'
import { MemoryTab } from './MemoryTab'

/**
 * Phase 8 — dev-only debug overlay.
 *
 * Keyboard: Shift+D toggles visibility, Esc closes. State (active tab,
 * filter text) persists across toggles thanks to component-level state
 * being preserved while the panel is only conditionally hidden rather
 * than unmounted.
 *
 * The panel is always mounted (so subscriptions keep running) but
 * visually hidden when `open === false`. That way re-opening is
 * instant and the filter the user typed last time is still there.
 */
type Tab = 'turns' | 'trace' | 'metrics' | 'network' | 'memory'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'turns', label: 'Turns' },
  { id: 'trace', label: 'Trace' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'network', label: 'Network' },
  { id: 'memory', label: 'Memory' },
]

export function DebugPanel() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('turns')

  // Keyboard handling lives at the window level so it works regardless
  // of focus. We deliberately don't use `preventDefault` on all keys —
  // only the ones we handle.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        // Don't fire while the user is typing into a text field — they
        // may just be capitalising a D.
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape') {
        setOpen((v) => (v ? false : v))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const events = useTracerSnapshot()

  return (
    <div
      data-testid="debug-panel"
      aria-hidden={!open}
      className={[
        'pointer-events-none absolute left-0 right-0 top-0 z-50 flex flex-col',
        'h-1/2 text-zinc-100',
        open ? '' : 'pointer-events-none invisible',
      ].join(' ')}
    >
      <div
        className={[
          'pointer-events-auto mx-4 mt-4 flex flex-1 flex-col gap-2 overflow-hidden rounded-lg',
          'bg-black/85 p-3 text-xs backdrop-blur-md ring-1 ring-zinc-800',
        ].join(' ')}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider opacity-60">
            Debug · Phase 8 · {events.length} events
          </span>
          <div className="ml-2 flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={[
                  'rounded px-2 py-0.5 text-[11px] uppercase tracking-wider',
                  tab === t.id
                    ? 'bg-cyan-700 text-white'
                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700',
                ].join(' ')}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="ml-auto text-[10px] opacity-50">
            Shift+D to toggle · Esc to close
          </span>
          <button
            onClick={() => tracer.clear()}
            className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] uppercase tracking-wider hover:bg-zinc-700"
            title="Clear all trace events"
          >
            Clear
          </button>
          <button
            onClick={() => setOpen(false)}
            className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] hover:bg-zinc-700"
            aria-label="Close debug panel"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-hidden rounded bg-zinc-950/70 p-2">
          {tab === 'turns' && <TurnsTab events={events} />}
          {tab === 'trace' && <TraceTab events={events} />}
          {tab === 'metrics' && <MetricsTab events={events} />}
          {tab === 'network' && <NetworkTab events={events} />}
          {tab === 'memory' && <MemoryTab />}
        </div>
      </div>
    </div>
  )
}

/**
 * Subscribes to the tracer and returns the live event list.
 *
 * Uses `useSyncExternalStore` with a module-level cache keyed on the
 * highest-seen event seq. `getSnapshot` must return the SAME reference
 * across calls when nothing has changed — otherwise React's concurrent
 * renderer detects "store changed" on every render and goes into a
 * tight update loop.
 *
 * Strategy: keep a cached `{ lastSeq, events }` at module scope. When
 * `getSnapshot` is called, peek the latest seq the tracer would have
 * produced; if it matches `lastSeq`, return the cached events ref.
 * Only on mismatch do we re-pull a fresh snapshot.
 */
function useTracerSnapshot(): TraceEvent[] {
  return useSyncExternalStore(
    subscribeCached,
    getCachedSnapshot,
  )
}

// NOTICE:
// Module-level cache — a single panel instance is assumed. If we ever
// render two panels, each would still see the same ref which is fine
// since the cache only invalidates when new events arrive.
// Root cause: `useSyncExternalStore` compares getSnapshot() returns by
// Object.is; returning a fresh array each call triggers an infinite loop.
// Source: React docs for useSyncExternalStore, "getSnapshot must return
// a cached value". Removal condition: replace with a store library that
// handles this automatically (not planned).
let cachedSnapshot: TraceEvent[] = tracer.getSnapshot()
let cachedLastSeq = lastSeqOf(cachedSnapshot)

function lastSeqOf(events: TraceEvent[]): number {
  return events.length === 0 ? -1 : events[events.length - 1].seq
}

function getCachedSnapshot(): TraceEvent[] {
  // Fast path: peek the tracer without building a new array. We can't
  // do that with the current Tracer API, so we take a fresh snapshot
  // and only publish it if the last seq changed.
  const fresh = tracer.getSnapshot()
  const freshSeq = lastSeqOf(fresh)
  if (freshSeq !== cachedLastSeq) {
    cachedSnapshot = fresh
    cachedLastSeq = freshSeq
  }
  return cachedSnapshot
}

function subscribeCached(onChange: () => void): () => void {
  return tracer.subscribe(() => {
    // Invalidate the cache so the next getSnapshot returns fresh data.
    // Don't build the snapshot here — react will call getSnapshot.
    cachedLastSeq = -2
    onChange()
  })
}
