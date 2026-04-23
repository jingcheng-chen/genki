import { useToastsStore, type Toast, type ToastKind } from '../stores/toasts'

/**
 * Phase 10 — Fixed top-center toast stack.
 *
 * Subscribes to `useToastsStore` and renders each toast with a
 * kind-specific colour. Dismiss button (x) removes the toast immediately;
 * auto-dismiss is handled inside the store via setTimeout.
 *
 * Design constraints:
 * - No animation library. A tiny opacity transition keeps things tidy.
 * - Stack grows downward; newer on the bottom. The container
 *   `pointer-events-none` so the overlay never blocks clicks on the
 *   3D scene; individual toasts re-enable with `pointer-events-auto`.
 */
export function Toasts() {
  const items = useToastsStore((s) => s.items)
  const dismiss = useToastsStore((s) => s.dismiss)

  if (items.length === 0) return null

  return (
    <div
      className={[
        'pointer-events-none fixed left-1/2 top-3 z-50 flex -translate-x-1/2 flex-col gap-2',
        'max-w-[90vw] items-center',
      ].join(' ')}
      role="status"
      aria-live="polite"
    >
      {items.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  )
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { kind, message } = toast
  return (
    <div
      className={[
        'pointer-events-auto flex items-start gap-2 rounded-md px-3 py-2 text-xs shadow-lg ring-1 backdrop-blur-md',
        KIND_CLASSES[kind],
        'max-w-md',
      ].join(' ')}
    >
      <span className="mt-[1px] text-[10px] font-bold uppercase tracking-wider opacity-80">
        {KIND_LABELS[kind]}
      </span>
      <span className="flex-1 break-words">{message}</span>
      <button
        onClick={onDismiss}
        className="rounded px-1 text-[10px] opacity-60 hover:bg-white/10 hover:opacity-100"
        aria-label="Dismiss notification"
      >
        x
      </button>
    </div>
  )
}

const KIND_CLASSES: Record<ToastKind, string> = {
  error: 'bg-rose-950/85 text-rose-100 ring-rose-700/50',
  warn: 'bg-amber-950/85 text-amber-100 ring-amber-700/50',
  info: 'bg-zinc-900/85 text-zinc-100 ring-zinc-700/50',
}

const KIND_LABELS: Record<ToastKind, string> = {
  error: 'Error',
  warn: 'Warn',
  info: 'Info',
}
