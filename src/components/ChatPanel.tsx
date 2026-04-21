import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ensureLipSyncDriver } from '../vrm/lip-sync-driver'
import { runTurn, type TurnHandle } from '../pipelines/turn'

type AudioStatus = 'idle' | 'initializing' | 'ready' | 'error'

interface UITurn {
  role: 'user' | 'assistant'
  content: string
  emotions?: Array<{ name: string; intensity: number }>
}

/**
 * Phase 4 chat panel.
 *
 * One combined UI:
 *  - "Click to enable audio" gate (unlocks AudioContext + wlipsync worklet).
 *  - Scrollable message list (the full conversation context sent to the LLM).
 *  - Input box; Enter sends, Shift+Enter adds a newline.
 *  - Stop button aborts LLM + TTS + current playback via the TurnHandle.
 */
export function ChatPanel() {
  const [status, setStatus] = useState<AudioStatus>('idle')
  const [audioError, setAudioError] = useState<string | null>(null)

  const [turns, setTurns] = useState<UITurn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [liveAssistant, setLiveAssistant] = useState('')
  const [turnError, setTurnError] = useState<string | null>(null)

  const turnHandleRef = useRef<TurnHandle | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // Scroll to bottom whenever the message log or live stream updates.
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [turns, liveAssistant])

  useEffect(() => () => turnHandleRef.current?.abort(), [])

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

  function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || streaming) return

    setTurnError(null)
    setInput('')
    setLiveAssistant('')

    const userTurn: UITurn = { role: 'user', content: trimmed }
    const nextTurns = [...turns, userTurn]
    setTurns(nextTurns)

    const emotionsSeen: Array<{ name: string; intensity: number }> = []
    let assistantText = ''

    setStreaming(true)
    const handle = runTurn({
      messages: nextTurns.map((t) => ({ role: t.role, content: t.content })),
      onAssistantText: (delta) => {
        assistantText += delta
        setLiveAssistant(assistantText)
      },
      onEmotion: (name, intensity) => {
        emotionsSeen.push({ name, intensity })
      },
      onStreamEnd: () => {
        // LLM tokens finished; playback may still be going.
        setTurns((prev) => [
          ...prev,
          { role: 'assistant', content: assistantText, emotions: emotionsSeen },
        ])
        setLiveAssistant('')
      },
    })
    turnHandleRef.current = handle

    handle.promise
      .catch((e) => setTurnError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setStreaming(false)
        turnHandleRef.current = null
        setLiveAssistant('')
      })
  }

  function handleStop() {
    turnHandleRef.current?.abort()
    // Preserve whatever we streamed so far as the assistant's turn, so the
    // LLM sees its own partial reply in the next round's context.
    if (liveAssistant.trim()) {
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', content: `${liveAssistant} [interrupted]` },
      ])
    }
    setLiveAssistant('')
    setStreaming(false)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleClear() {
    if (streaming) return
    setTurns([])
    setLiveAssistant('')
    setTurnError(null)
  }

  const disabled = status !== 'ready'

  return (
    <div className="pointer-events-auto absolute bottom-4 right-4 flex h-[28rem] w-96 flex-col gap-2 rounded-lg bg-black/60 p-3 text-sm backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <div className="font-semibold opacity-80">Phase 4 · chat</div>
        <button
          onClick={handleClear}
          disabled={streaming || turns.length === 0}
          className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wider hover:bg-zinc-700 disabled:opacity-30"
        >
          Clear
        </button>
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
            {turns.length === 0 && !liveAssistant && (
              <div className="opacity-50">Say something to start…</div>
            )}
            {turns.map((t, i) => (
              <Turn key={i} turn={t} />
            ))}
            {liveAssistant && (
              <Turn turn={{ role: 'assistant', content: liveAssistant }} live />
            )}
          </div>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Type a message… (Enter to send)"
            disabled={disabled || streaming}
            className="resize-none rounded bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none ring-1 ring-zinc-700 focus:ring-cyan-500 disabled:opacity-50"
          />

          <div className="flex gap-2">
            <button
              onClick={handleSend}
              disabled={disabled || streaming || !input.trim()}
              className="flex-1 rounded bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:opacity-40"
            >
              {streaming ? 'Speaking…' : 'Send'}
            </button>
            <button
              onClick={handleStop}
              disabled={!streaming}
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

function Turn({ turn, live }: { turn: UITurn; live?: boolean }) {
  const isUser = turn.role === 'user'
  return (
    <div className={isUser ? 'text-right' : 'text-left'}>
      <div
        className={[
          'inline-block max-w-[85%] rounded-md px-2 py-1 align-top',
          isUser ? 'bg-cyan-900/60 text-cyan-50' : 'bg-zinc-800 text-zinc-100',
          live ? 'opacity-80' : '',
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
