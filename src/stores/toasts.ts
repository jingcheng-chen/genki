import { create } from 'zustand'

/**
 * Phase 10 — Transient-notification store.
 *
 * Lightweight stand-in for a toast library. Each toast has a kind (for
 * color + default TTL), a message, and a monotonically-increasing id.
 * The <Toasts /> component subscribes and renders them stacked top-center.
 *
 * Auto-dismiss is handled here (via `setTimeout`) rather than in the
 * component so dismissal still fires when the component is momentarily
 * unmounted (e.g. during a Suspense re-render).
 */

export type ToastKind = 'error' | 'warn' | 'info'

export interface Toast {
  id: string
  kind: ToastKind
  message: string
  /** TTL in ms from insertion until auto-dismiss. */
  ttlMs: number
}

export interface ToastInput {
  kind: ToastKind
  message: string
  /** Optional override for default TTL. */
  ttlMs?: number
}

export interface ToastsState {
  items: Toast[]
  push: (t: ToastInput) => string
  dismiss: (id: string) => void
  clear: () => void
}

/** Per-kind defaults. Error gets longest since it's the most actionable. */
const DEFAULT_TTL: Record<ToastKind, number> = {
  error: 8000,
  warn: 6000,
  info: 4000,
}

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `t_${idCounter.toString(36)}_${Math.floor(Math.random() * 0xffff).toString(16)}`
}

export const useToastsStore = create<ToastsState>()((set, get) => ({
  items: [],
  push: ({ kind, message, ttlMs }) => {
    const id = nextId()
    const finalTtl = ttlMs ?? DEFAULT_TTL[kind]
    set((state) => ({ items: [...state.items, { id, kind, message, ttlMs: finalTtl }] }))
    // Fire-and-forget auto-dismiss. If `dismiss` has already been called
    // manually by the time the timer fires, the `dismiss` call is a no-op.
    setTimeout(() => {
      // Read latest state — if the toast is still there, drop it.
      if (get().items.some((t) => t.id === id)) {
        get().dismiss(id)
      }
    }, finalTtl)
    return id
  },
  dismiss: (id) =>
    set((state) => ({ items: state.items.filter((t) => t.id !== id) })),
  clear: () => set({ items: [] }),
}))

/**
 * Convenience wrapper so non-React call sites (turn controller, memory
 * extractor) don't have to thread the store reference through.
 *
 * @example
 *   pushToast({ kind: 'error', message: 'STT failed' })
 */
export function pushToast(input: ToastInput): string {
  return useToastsStore.getState().push(input)
}
