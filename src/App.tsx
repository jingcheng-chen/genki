import { Suspense } from 'react'
import { Scene } from './vrm/Scene'
import { ChatPanel } from './components/ChatPanel'

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

      <div className="pointer-events-none absolute left-4 top-4 text-xs opacity-60">
        AI Companion · Phase 5
      </div>

      <ChatPanel />
    </div>
  )
}
