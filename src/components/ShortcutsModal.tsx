import { useEffect } from 'react'

/**
 * Phase 10 — Keyboard-shortcuts help modal.
 *
 * Single small overlay listing the shortcuts the app owns. Intentionally
 * not a settings panel — just a cheatsheet. Opens via `?` (or Shift+?),
 * closes via Esc or the backdrop / close button.
 */

export interface ShortcutsModalProps {
  open: boolean
  onClose: () => void
}

interface ShortcutRow {
  keys: string[]
  label: string
}

const ROWS: ShortcutRow[] = [
  { keys: ['?'], label: 'Show this cheatsheet' },
  { keys: ['M'], label: 'Toggle microphone' },
  { keys: ['Cmd', 'K'], label: 'Clear chat history (Ctrl+K on Windows/Linux)' },
  { keys: ['Shift', 'D'], label: 'Toggle debug panel' },
  { keys: ['Esc'], label: 'Close modals, stop speaking' },
  { keys: ['Enter'], label: 'Send message (in chat input)' },
  { keys: ['Shift', 'Enter'], label: 'New line (in chat input)' },
]

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  // Close on Escape. Bound imperatively so it works regardless of focus.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className={[
        'fixed inset-0 z-40 flex items-center justify-center',
        'bg-black/50 backdrop-blur-sm',
      ].join(' ')}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={[
          'w-[min(28rem,90vw)] rounded-xl bg-zinc-950/95 p-5 shadow-2xl ring-1 ring-zinc-800',
          'text-sm text-zinc-100',
        ].join(' ')}
      >
        <div className="mb-3 flex items-center gap-2">
          <div className="text-base font-semibold">Keyboard shortcuts</div>
          <span className="ml-auto text-[10px] uppercase tracking-wider opacity-50">
            Press Esc to close
          </span>
          <button
            onClick={onClose}
            className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] hover:bg-zinc-700"
            aria-label="Close shortcuts"
          >
            x
          </button>
        </div>
        <ul className="flex flex-col gap-1.5">
          {ROWS.map((row, i) => (
            <li key={i} className="flex items-center gap-3">
              <div className="flex flex-wrap gap-1">
                {row.keys.map((k, j) => (
                  <kbd
                    key={j}
                    className={[
                      'rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] font-medium',
                      'ring-1 ring-zinc-700',
                    ].join(' ')}
                  >
                    {k}
                  </kbd>
                ))}
              </div>
              <span className="flex-1 text-[13px] opacity-80">{row.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
