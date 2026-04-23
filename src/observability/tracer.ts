import type { TraceCategory, TraceEvent } from './types'

/**
 * Phase 8 — in-process event tracer.
 *
 * Design:
 *  - Ring buffer of fixed capacity. Wraps on overflow so long sessions
 *    stay within a bounded memory footprint.
 *  - `emit({ category, data, turnId })` — assigns `seq` + `ts`, stores
 *    the event, fans out to subscribers.
 *  - `subscribe(listener)` — fires on every new event. Returns an
 *    unsubscribe function.
 *  - `getSnapshot()` — returns the currently-buffered events (ordered
 *    oldest → newest), used by the debug panel on mount.
 *  - `clear()` — empties the ring. Useful for tests and the "Clear"
 *    button on the Trace tab.
 *
 * Dev-only: when `import.meta.env.DEV` is falsy, the exported singleton
 * degrades to a no-op so production bundles pay zero cost at call sites.
 *
 * Call stack (conceptual):
 *
 * tracer.emit
 *   -> ring buffer append
 *   -> for each subscriber listener(event)
 */

const DEFAULT_CAPACITY = 1000

/**
 * Event input shape accepted by `emit`. The tracer fills in `seq` and
 * `ts` so callers don't have to.
 */
export interface EmitInput {
  category: TraceCategory
  data: unknown
  turnId?: string | null
}

export interface Tracer {
  emit(input: EmitInput): void
  subscribe(listener: (ev: TraceEvent) => void): () => void
  getSnapshot(): TraceEvent[]
  clear(): void
  readonly capacity: number
}

/**
 * Creates an isolated tracer instance. Tests get their own via this
 * factory; production uses the module-level singleton below.
 *
 * Use when:
 * - Writing a unit test that needs a fresh ring buffer.
 * - Running multiple independent traces side-by-side (rare).
 *
 * Returns:
 * - A tracer with a ring buffer of the given capacity.
 */
export function createTracer(capacity = DEFAULT_CAPACITY): Tracer {
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error(`[tracer] capacity must be positive, got ${capacity}`)
  }

  // Ring storage — we use a plain array and an index pointer, writing
  // in-place on wrap. `count` tracks how many slots are filled so the
  // snapshot function can return entries in oldest→newest order without
  // materialising a second array during steady-state.
  const buffer: (TraceEvent | undefined)[] = new Array(capacity)
  let head = 0
  let count = 0
  let seq = 0
  const listeners = new Set<(ev: TraceEvent) => void>()

  function emit(input: EmitInput): void {
    const ev: TraceEvent = {
      seq: seq++,
      ts: Date.now(),
      category: input.category,
      data: input.data,
      turnId: input.turnId ?? null,
    }
    buffer[head] = ev
    head = (head + 1) % capacity
    if (count < capacity) count++

    // Fan out to subscribers. Copy the listener set so an unsubscribe
    // during iteration doesn't skip a listener.
    for (const l of [...listeners]) {
      try {
        l(ev)
      } catch (err) {
        // Never let a misbehaving subscriber kill the producer. We swallow
        // the error and carry on — the subscriber can instrument its own
        // try/catch if it needs richer diagnostics.
        if (typeof console !== 'undefined') {
          console.error(
            '[tracer] subscriber threw',
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }
  }

  function subscribe(listener: (ev: TraceEvent) => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  function getSnapshot(): TraceEvent[] {
    if (count === 0) return []
    const out: TraceEvent[] = new Array(count)
    // Oldest entry is at `head - count` (mod capacity) when we've wrapped,
    // or at index 0 when we haven't. Walk `count` slots starting there.
    const start = (head - count + capacity) % capacity
    for (let i = 0; i < count; i++) {
      const ev = buffer[(start + i) % capacity]
      if (ev) out[i] = ev
    }
    return out
  }

  function clear(): void {
    for (let i = 0; i < capacity; i++) buffer[i] = undefined
    head = 0
    count = 0
    // Intentionally do NOT reset `seq` — downstream consumers may still
    // be holding stale event refs; keeping seq monotonic avoids confusion.
  }

  return { emit, subscribe, getSnapshot, clear, capacity }
}

/**
 * No-op tracer used in production. Same shape as `createTracer` so call
 * sites are identical — `tracer.emit(…)` at call sites cost a single
 * indirect call in prod, no heap allocations.
 */
function createNoopTracer(): Tracer {
  return {
    emit: () => {},
    subscribe: () => () => {},
    getSnapshot: () => [],
    clear: () => {},
    capacity: 0,
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton. Dev gets the real tracer; production gets a no-op
// so the panel (and its emit sites) leave no runtime footprint.
// ---------------------------------------------------------------------------
//
// NOTICE:
// We read `import.meta.env.DEV` once at module init and freeze the choice.
// Vite inlines DEV as a boolean literal at build time, so the dead branch
// is eliminated by the bundler — production bundles don't even carry the
// real tracer's code. Tests run with DEV=true via Vite's test mode.

const DEV = !!(
  typeof import.meta !== 'undefined' &&
  import.meta.env &&
  import.meta.env.DEV
)

export const tracer: Tracer = DEV ? createTracer() : createNoopTracer()

/** True if the singleton is the real tracer (dev/test). Useful for
 *  skipping expensive string construction at emit sites when we're in
 *  production (the emit itself is already free, but building the payload
 *  isn't). */
export const TRACER_ACTIVE = DEV
