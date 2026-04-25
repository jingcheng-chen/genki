import { useEffect } from 'react'

interface Handlers {
  onPrev: () => void
  onNext: () => void
  onTogglePlaying: () => void
  onToggleLoop: () => void
  onDelete: () => void
  onReload: () => void
}

/**
 * Single keydown listener that wires the triage shortcuts at the window
 * level. Ignores keys when the target is an input, textarea, or
 * contenteditable element so the focus state in the asset manager doesn't
 * eat user typing in any future free-form fields.
 */
export function useTriageHotkeys(h: Handlers) {
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      )
        return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          h.onTogglePlaying()
          break
        case 'j':
        case 'J':
        case 'ArrowUp':
          e.preventDefault()
          h.onPrev()
          break
        case 'k':
        case 'K':
        case 'ArrowDown':
          e.preventDefault()
          h.onNext()
          break
        case 'l':
        case 'L':
          e.preventDefault()
          h.onToggleLoop()
          break
        case 'd':
        case 'D':
          e.preventDefault()
          h.onDelete()
          break
        case 'r':
        case 'R':
          e.preventDefault()
          h.onReload()
          break
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [h])
}
