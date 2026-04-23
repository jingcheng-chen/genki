import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  createTurnController,
  type TurnController,
  type TurnState,
  type UITurn,
} from '../pipelines/turn-controller'
import { useCharacterStore } from '../stores/character'
import { useSceneStore } from '../stores/scene'
import { getPreset } from '../vrm/presets'
import { pushToast } from '../stores/toasts'
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts'

/**
 * Phase 5 chat panel — Phase 10 cold-start polish.
 *
 * StartGate owns the audio-context gesture now, so this panel assumes
 * audio is ready by the time it renders its interactive surface. The
 * panel's DOM is still mounted during StartGate's display (so the turn
 * controller subscriptions live) but the panel is visually gated on
 * `sceneStatus === 'ready'`.
 *
 * Features:
 *  - Mic toggle (VAD mode) — hands-free turn-taking + barge-in.
 *  - Scrollable message list mirroring the controller's history.
 *  - Input box; Enter sends, Shift+Enter adds a newline.
 *  - Stop button aborts current turn and commits `[interrupted]` to history.
 */
const FIRST_RUN_FLAG = 'ai-companion-seen-first-run'
const PLACEHOLDER_SUGGESTION = "Try: 'Tell me about yourself'"

export function ChatPanel() {
  const sceneStatus = useSceneStore((s) => s.status)
  // The gate keeps the panel visually muted before first start so the
  // user knows where to click. `ready` means the gate's audio init
  // finished — dismissed by the StartGate component itself.
  const audioReady = sceneStatus === 'ready'

  const activePresetId = useCharacterStore((s) => s.activePresetId)

  // Controller is created once per mount. In dev StrictMode this runs
  // twice — harmless, `createTurnController` allocates nothing that would
  // leak until the first `startMic()` call.
  //
  // `getPreset` reads the store fresh on each turn so switching
  // characters mid-session picks up the new persona / voice / custom
  // instructions without having to recreate the controller.
  const controller = useMemo<TurnController>(
    () =>
      createTurnController({
        getPreset: () => {
          const state = useCharacterStore.getState()
          const p = getPreset(state.activePresetId)
          return {
            id: p.id,
            persona: p.persona,
            voiceId: p.voiceId,
            customInstructions: state.customInstructions[state.activePresetId],
          }
        },
      }),
    [],
  )
  const [turnState, setTurnState] = useState<TurnState>('idle')
  const [history, setHistory] = useState<UITurn[]>([])
  const [liveAssistant, setLiveAssistant] = useState('')
  const [micOn, setMicOn] = useState(false)
  const [micPending, setMicPending] = useState(false)
  const [input, setInput] = useState('')

  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const unsub = controller.subscribe((ev) => {
      switch (ev.type) {
        case 'state':
          setTurnState(ev.state)
          break
        case 'history':
          setHistory(controller.getHistory())
          setLiveAssistant(controller.getLiveAssistant())
          break
        case 'assistant-delta':
          setLiveAssistant(controller.getLiveAssistant())
          break
        case 'error':
          // Phase 10 — surface pipeline errors through the toast stack.
          // The in-panel inline error (below the message that failed)
          // is gone; toasts are the primary surface now.
          pushToast({ kind: 'error', message: ev.message })
          break
      }
    })
    return () => {
      unsub()
      void controller.destroy()
    }
  }, [controller])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [history, liveAssistant])

  // On character switch: abort any in-flight reply and reset the chat.
  // A half-delivered Mika line doesn't make sense once the user has
  // flipped to Ani — the voice and persona would change mid-sentence.
  const isFirstPresetRun = useRef(true)
  useEffect(() => {
    if (isFirstPresetRun.current) {
      isFirstPresetRun.current = false
      return
    }
    controller.abort()
    controller.clearHistory()
  }, [activePresetId, controller])

  async function handleToggleMic() {
    if (!audioReady) return
    setMicPending(true)
    try {
      if (micOn) {
        await controller.stopMic()
        setMicOn(false)
      } else {
        await controller.startMic()
        setMicOn(true)
      }
    } catch (e) {
      pushToast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setMicPending(false)
    }
  }

  function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || !audioReady) return
    setInput('')
    controller.sendText(trimmed)
  }

  function handleStop() {
    controller.abort()
  }

  function handleClear() {
    if (turnState === 'speaking' || turnState === 'thinking') return
    controller.clearHistory()
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Phase 10 global shortcuts:
  //   - M: toggle mic (only when idle — we don't want to kill a live turn)
  //   - Cmd/Ctrl+K: clear chat history
  //   - Esc: stop the assistant mid-speech (only when it's actually speaking)
  useGlobalShortcuts({
    m: () => {
      if (!audioReady) return
      if (micPending) return
      void handleToggleMic()
    },
    'mod+k': (e) => {
      // preventDefault so Cmd+K doesn't open the browser's address-bar
      // search on browsers that bind it there.
      e.preventDefault()
      handleClear()
    },
    escape: () => {
      if (turnState === 'speaking' || turnState === 'thinking') {
        handleStop()
      }
    },
  })

  const busy = turnState === 'thinking' || turnState === 'speaking'

  // Show a prompt-starter placeholder exactly once per browser so repeat
  // users aren't nudged forever. The flag is checked lazily at render time
  // rather than put in state; any write to localStorage is guarded below.
  const firstRun = useFirstRun()

  return (
    <div
      className={[
        'pointer-events-auto absolute bottom-4 right-4 flex h-[30rem] w-96 flex-col gap-2 rounded-lg bg-black/60 p-3 text-sm backdrop-blur-sm',
        audioReady ? '' : 'pointer-events-none opacity-60',
      ].join(' ')}
      aria-hidden={!audioReady}
    >
      <div className="flex items-center gap-2">
        <div className="font-semibold opacity-80">Voice chat</div>
        <StateChip state={turnState} micOn={micOn} />
        <button
          onClick={handleClear}
          disabled={busy || history.length === 0}
          className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wider hover:bg-zinc-700 disabled:opacity-30"
          title="Clear history (Cmd/Ctrl+K)"
        >
          Clear
        </button>
        <button
          onClick={handleToggleMic}
          disabled={micPending || !audioReady}
          className={[
            'rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white',
            micOn
              ? 'bg-rose-600 hover:bg-rose-500'
              : 'bg-cyan-700 hover:bg-cyan-600',
            'disabled:cursor-not-allowed disabled:opacity-40',
          ].join(' ')}
          title={micOn ? 'Stop listening (M)' : 'Start listening (M)'}
        >
          {micPending ? '…' : micOn ? '● Mic' : '○ Mic'}
        </button>
      </div>

      <div
        ref={listRef}
        className="flex-1 space-y-2 overflow-y-auto rounded bg-zinc-950/60 p-2 text-xs"
      >
        {history.length === 0 && !liveAssistant && turnState === 'idle' && (
          <div className="opacity-50">
            {micOn
              ? 'Mic is on — just start talking.'
              : 'Turn on the mic or type to start.'}
          </div>
        )}
        {history.map((t, i) => (
          <Turn key={i} turn={t} />
        ))}
        {(turnState === 'listening' || turnState === 'transcribing') && (
          <EphemeralTurn kind="user" state={turnState} />
        )}
        {liveAssistant && (
          <Turn turn={{ role: 'assistant', content: liveAssistant }} live />
        )}
      </div>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        placeholder={
          micOn
            ? 'Or type a message… (Enter to send)'
            : firstRun
              ? PLACEHOLDER_SUGGESTION
              : 'Type a message… (Enter to send)'
        }
        disabled={!audioReady}
        className="resize-none rounded bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none ring-1 ring-zinc-700 focus:ring-cyan-500 disabled:opacity-50"
      />

      <div className="flex gap-2">
        <button
          onClick={handleSend}
          disabled={!audioReady || !input.trim()}
          className="flex-1 rounded bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:opacity-40"
        >
          Send
        </button>
        <button
          onClick={handleStop}
          disabled={!busy}
          className="rounded bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:opacity-40"
          title="Stop (Esc)"
        >
          ■ Stop
        </button>
      </div>
    </div>
  )
}

/**
 * Returns true exactly once per browser session — we use it to hint a
 * prompt starter in the input placeholder on first visit. After the user
 * sends their first turn we flip the flag in localStorage so the hint
 * doesn't stick around.
 *
 * Swallows localStorage errors (private mode, quota) and treats them as
 * "not first run" — better to hide the hint than to crash.
 */
function useFirstRun(): boolean {
  // We're cheap about reactivity here — the hint is rendered once and we
  // don't need to track re-flips. Reading at module/effect scope would
  // work too; inline useState keeps React semantics clean.
  const [firstRun] = useState<boolean>(() => {
    try {
      return typeof window !== 'undefined' &&
        window.localStorage.getItem(FIRST_RUN_FLAG) === null
    } catch {
      return false
    }
  })
  // Flag the user as "seen" on mount (not on send) so a user who only
  // browses doesn't get the hint next time either. Simplest behaviour.
  useEffect(() => {
    if (!firstRun) return
    try {
      window.localStorage.setItem(FIRST_RUN_FLAG, '1')
    } catch {
      /* ignore */
    }
  }, [firstRun])
  return firstRun
}

function StateChip({ state, micOn }: { state: TurnState; micOn: boolean }) {
  const { label, color } = stateChip(state, micOn)
  return (
    <span
      className={[
        'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
        color,
      ].join(' ')}
    >
      {label}
    </span>
  )
}

function stateChip(state: TurnState, micOn: boolean) {
  switch (state) {
    case 'listening':
      return { label: 'listening', color: 'bg-amber-600 text-white' }
    case 'transcribing':
      return { label: 'transcribing', color: 'bg-amber-500 text-black' }
    case 'thinking':
      return { label: 'thinking', color: 'bg-sky-600 text-white' }
    case 'speaking':
      return { label: 'speaking', color: 'bg-emerald-600 text-white' }
    case 'idle':
    default:
      return {
        label: micOn ? 'idle · mic on' : 'idle',
        color: micOn
          ? 'bg-zinc-700 text-emerald-300'
          : 'bg-zinc-800 text-zinc-400',
      }
  }
}

function Turn({ turn, live }: { turn: UITurn; live?: boolean }) {
  const isUser = turn.role === 'user'
  return (
    <div className={isUser ? 'text-right' : 'text-left'}>
      <div
        className={[
          'inline-block max-w-[85%] rounded-md px-2 py-1 align-top',
          isUser ? 'bg-cyan-900/60 text-cyan-50' : 'bg-zinc-800 text-zinc-100',
          live ? 'opacity-80' : '',
          turn.interrupted ? 'italic opacity-70' : '',
        ].join(' ')}
      >
        {turn.content || (live ? '…' : '')}
      </div>
      {turn.emotions && turn.emotions.length > 0 && (
        <div className="mt-0.5 flex flex-wrap justify-start gap-1 text-[10px] opacity-60">
          {turn.emotions.map((e, i) => (
            <span key={i} className="rounded bg-zinc-900 px-1.5 py-0.5">
              {e.name} · {Math.round(e.intensity * 100)}%
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function EphemeralTurn({
  kind,
  state,
}: {
  kind: 'user'
  state: TurnState
}) {
  const label =
    state === 'listening' ? 'listening…' : 'transcribing…'
  return (
    <div className={kind === 'user' ? 'text-right' : 'text-left'}>
      <div className="inline-block max-w-[85%] rounded-md bg-cyan-950/60 px-2 py-1 align-top text-cyan-200/80">
        {label}
      </div>
    </div>
  )
}
