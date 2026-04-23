import { Suspense } from 'react'
import { Scene } from './vrm/Scene'
import { ChatPanel } from './components/ChatPanel'
import { CharacterPicker } from './components/CharacterPicker'

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
    </div>
  )
}
