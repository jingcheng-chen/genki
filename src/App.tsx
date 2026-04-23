import { Suspense, useState } from 'react'
import { Scene } from './vrm/Scene'
import { ChatPanel } from './components/ChatPanel'
import { CharacterPicker } from './components/CharacterPicker'
import { DebugPanel } from './components/debug/DebugPanel'
import { StartGate } from './components/StartGate'
import { Toasts } from './components/Toasts'
import { ShortcutsModal } from './components/ShortcutsModal'
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts'

export function App() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // `?` / Shift+? opens the cheatsheet. Matching the literal "?" key lets
  // users on US layouts hit Shift+/ without us having to encode the
  // physical key code.
  useGlobalShortcuts({
    '?': () => setShortcutsOpen((v) => !v),
    'shift+?': () => setShortcutsOpen((v) => !v),
  })

  return (
    <div className="relative h-full w-full">
      <Suspense
        fallback={
          <div className="flex h-full w-full items-center justify-center text-sm opacity-70">
            Loading avatar…
          </div>
        }
      >
        <Scene />
      </Suspense>

      <CharacterPicker />
      <ChatPanel />
      <Toasts />
      <StartGate />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {/* Phase 8 — dev-only. Hidden by default, Shift+D to toggle. Memory
          inspector is folded into this panel's Memory tab. */}
      {import.meta.env.DEV && <DebugPanel />}
    </div>
  )
}
