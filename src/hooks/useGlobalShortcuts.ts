import { useEffect, useRef } from 'react'

/**
 * Phase 10 — Centralised keyboard-shortcut hook.
 *
 * Multiple components want global keystrokes (Shift+D for debug panel,
 * M for mic, Cmd/Ctrl+K for clear chat, Shift+? for help). Without a
 * single owner they start fighting over `window.addEventListener('keydown')`
 * and ordering becomes invisible. This hook gives each caller a typed
 * contract and handles the "is the user typing into an input" gate in
 * one place.
 *
 * Usage:
 *
 *   useGlobalShortcuts({
 *     'shift+d': () => setDebugOpen((v) => !v),
 *     'm': () => toggleMic(),
 *   })
 *
 * Keys are normalised: case-insensitive, modifiers in the order
 * `ctrl` | `meta` | `shift` | `alt` followed by a single key. `meta`
 * matches Cmd on macOS. `mod` is a cross-platform alias for
 * `ctrl`-on-Windows / `meta`-on-Mac — use it for common chords like
 * Cmd/Ctrl+K.
 */

export type ShortcutHandler = (e: KeyboardEvent) => void

export interface UseGlobalShortcutsOptions {
  /** When false, all shortcuts in this hook are inactive. Useful when
   *  a modal wants to claim the keyboard. @default true */
  enabled?: boolean
  /** When true, shortcuts fire even inside inputs. @default false */
  allowInInputs?: boolean
}

/**
 * Build a canonical chord string from a KeyboardEvent.
 *
 * Before:
 * - KeyboardEvent{ key: 'K', metaKey: true, shiftKey: false }
 *
 * After:
 * - "meta+k"
 */
function chordFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.metaKey) parts.push('meta')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  // Normalise the key. Letters come through as uppercase when Shift is
  // held; lowercase the whole thing so "shift+d" / "escape" / "arrowdown"
  // all match regardless of caps-lock or browser normalisation quirks.
  const key = e.key.toLowerCase()
  parts.push(key)
  return parts.join('+')
}

function isFromInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if ((target as HTMLElement).isContentEditable) return true
  return false
}

/**
 * Normalise a user-provided chord key. `mod+k` becomes `meta+k` on macOS
 * and `ctrl+k` elsewhere.
 *
 * Before:
 * - "Mod+K"
 *
 * After:
 * - "meta+k" (macOS) or "ctrl+k" (Windows/Linux)
 */
function normaliseChord(chord: string, isMac: boolean): string {
  return chord
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .map((p) => (p === 'mod' ? (isMac ? 'meta' : 'ctrl') : p))
    .filter(Boolean)
    .join('+')
}

/**
 * Register global keyboard shortcuts for the lifetime of the caller.
 *
 * Use when:
 * - A component wants one or more document-level shortcuts.
 *
 * Expects:
 * - `shortcuts` is a plain map of chord strings -> handlers. Handlers
 *   don't need referential stability; the hook reads the latest version
 *   via a ref so inline arrow functions are safe.
 *
 * Returns:
 * - void. Cleans up on unmount.
 */
export function useGlobalShortcuts(
  shortcuts: Record<string, ShortcutHandler>,
  options: UseGlobalShortcutsOptions = {},
): void {
  const { enabled = true, allowInInputs = false } = options
  // Ref-pattern so callers can pass inline handlers without the effect
  // re-binding window.addEventListener on every render.
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts

  useEffect(() => {
    if (!enabled) return
    const isMac =
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPad/i.test(navigator.platform)

    function onKey(e: KeyboardEvent) {
      if (!allowInInputs && isFromInput(e.target)) return
      const chord = chordFromEvent(e)
      // Build the lookup against the current shortcut map. We rebuild
      // per-event — O(n) in map size — which beats re-binding the window
      // listener on every render. For the tiny shortcut sets we have in
      // this app, the per-event cost is negligible.
      const entries = Object.entries(shortcutsRef.current)
      for (const [raw, handler] of entries) {
        if (normaliseChord(raw, isMac) === chord) {
          handler(e)
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, allowInInputs])
}
