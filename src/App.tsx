import { Suspense } from 'react'
import { Scene } from './vrm/Scene'
import { ChatPanel } from './components/ChatPanel'
import { CharacterPicker } from './components/CharacterPicker'
import { DebugPanel } from './components/debug/DebugPanel'

export function App() {
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
      {/* Phase 8 — dev-only. Hidden by default, Shift+D to toggle. Memory
          inspector is folded into this panel's Memory tab. */}
      {import.meta.env.DEV && <DebugPanel />}
    </div>
  )
}
