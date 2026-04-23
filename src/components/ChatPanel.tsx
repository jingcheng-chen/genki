import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { ensureLipSyncDriver } from '../vrm/lip-sync-driver'
import {
  createTurnController,
  type TurnController,
  type TurnState,
  type UITurn,
} from '../pipelines/turn-controller'
import { useCharacterStore } from '../stores/character'
import { getPreset } from '../vrm/presets'

type AudioStatus = 'idle' | 'initializing' | 'ready' | 'error'

/**
 * Phase 5 chat panel.
 *
 * One combined UI:
 *  - "Click to enable audio" gate (unlocks AudioContext + wlipsync worklet).
 *  - Mic toggle (VAD mode) — hands-free turn-taking + barge-in.
 *  - Scrollable message list mirroring the controller's history.
 *  - Input box; Enter sends, Shift+Enter adds a newline.
 *  - Stop button aborts current turn and commits `[interrupted]` to history.
 */
export function ChatPanel() {
  const [status, setStatus] = useState<AudioStatus>('idle')
  const [audioError, setAudioError] = useState<string | null>(null)

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
  const [turnError, setTurnError] = useState<string | null>(null)

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
          setTurnError(ev.message)
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

  async function handleEnableAudio() {
    setStatus('initializing')
    setAudioError(null)
    try {
      await ensureLipSyncDriver()
      setStatus('ready')
    } catch (e) {
      setStatus('error')
      setAudioError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleToggleMic() {
    setTurnError(null)
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
      setTurnError(e instanceof Error ? e.message : String(e))
    } finally {
      setMicPending(false)
    }
  }

  function handleSend() {
    const trimmed = input.trim()
    if (!trimmed) return
    setTurnError(null)
    setInput('')
    controller.sendText(trimmed)
  }

  function handleStop() {
    controller.abort()
  }

  function handleClear() {
    if (turnState === 'speaking' || turnState === 'thinking') return
    controller.clearHistory()
    setTurnError(null)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const busy = turnState === 'thinking' || turnState === 'speaking'
  const canEdit = status === 'ready'

  return (
    <div className="pointer-events-auto absolute bottom-4 right-4 flex h-[30rem] w-96 flex-col gap-2 rounded-lg bg-black/60 p-3 text-sm backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <div className="font-semibold opacity-80">Voice chat</div>
        <StateChip state={turnState} micOn={micOn} />
        <button
          onClick={handleClear}
          disabled={busy || history.length === 0}
          className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wider hover:bg-zinc-700 disabled:opacity-30"
        >
          Clear
        </button>
        {status === 'ready' && (
          <button
            onClick={handleToggleMic}
            disabled={micPending}
            className={[
              'rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white',
              micOn
                ? 'bg-rose-600 hover:bg-rose-500'
                : 'bg-cyan-700 hover:bg-cyan-600',
              'disabled:cursor-not-allowed disabled:opacity-40',
            ].join(' ')}
            title={micOn ? 'Stop listening' : 'Start listening'}
          >
            {micPending ? '…' : micOn ? '● Mic' : '○ Mic'}
          </button>
        )}
      </div>

      {status === 'idle' && (
        <button
          onClick={handleEnableAudio}
          className="rounded bg-cyan-600 px-3 py-2 font-medium text-white hover:bg-cyan-500"
        >
          Click to enable audio
        </button>
      )}
      {status === 'initializing' && <div className="opacity-70">Initializing…</div>}
      {status === 'error' && (
        <div className="break-words text-rose-400">Audio init failed: {audioError}</div>
      )}

      {status === 'ready' && (
        <>
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
                : 'Type a message… (Enter to send)'
            }
            disabled={!canEdit}
            className="resize-none rounded bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none ring-1 ring-zinc-700 focus:ring-cyan-500 disabled:opacity-50"
          />

          <div className="flex gap-2">
            <button
              onClick={handleSend}
              disabled={!canEdit || !input.trim()}
              className="flex-1 rounded bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:opacity-40"
            >
              Send
            </button>
            <button
              onClick={handleStop}
              disabled={!busy}
              className="rounded bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:opacity-40"
            >
              ■ Stop
            </button>
          </div>

          {turnError && (
            <div className="max-w-full break-words text-xs text-rose-400">
              {turnError}
            </div>
          )}
        </>
      )}
    </div>
  )
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
