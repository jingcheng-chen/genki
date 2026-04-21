import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { decodeAudioFile } from '../audio/context'
import {
  createPlaybackSource,
  ensureLipSyncDriver,
  getLipSyncDriver,
} from '../vrm/lip-sync-driver'
import { speak, type SpeakHandle } from '../pipelines/speech-pipeline'

type Status = 'idle' | 'initializing' | 'ready' | 'error'

/**
 * Phase 2 + 3 debug overlay.
 *
 *   - Phase 2: upload any audio file, press play, watch the mouth sync.
 *   - Phase 3: type into the textarea, press Speak — the character reads
 *     it aloud via ElevenLabs TTS with matching mouth movement.
 *
 * Both paths converge on the same `createPlaybackSource`: the audio is
 * connected to the speakers AND to the wlipsync analyzer, so lip-sync is
 * "free" regardless of audio origin.
 */
export function AudioDebugPanel() {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)

  // Phase 2 (file playback) state
  const [fileName, setFileName] = useState<string | null>(null)
  const [filePlaying, setFilePlaying] = useState(false)
  const bufferRef = useRef<AudioBuffer | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)

  // Phase 3 (TTS) state
  const [speakText, setSpeakText] = useState(
    'Hi there. I can hear you now, and I can speak back. Try me.',
  )
  const [speaking, setSpeaking] = useState(false)
  const speakHandleRef = useRef<SpeakHandle | null>(null)

  useEffect(() => {
    return () => {
      sourceRef.current?.stop()
      sourceRef.current?.disconnect()
      speakHandleRef.current?.abort()
    }
  }, [])

  async function handleStart() {
    setStatus('initializing')
    setError(null)
    try {
      await ensureLipSyncDriver()
      setStatus('ready')
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const buf = await decodeAudioFile(file)
      bufferRef.current = buf
      setFileName(file.name)
    } catch (err) {
      setError(`Decode failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function handlePlayFile() {
    const driver = getLipSyncDriver()
    const buf = bufferRef.current
    if (!driver || !buf) return
    handleStopFile()

    const src = createPlaybackSource(buf, driver)
    src.onended = () => {
      setFilePlaying(false)
      driver.disconnectSource(src)
      sourceRef.current = null
    }
    src.start()
    sourceRef.current = src
    setFilePlaying(true)
  }

  function handleStopFile() {
    const src = sourceRef.current
    if (!src) return
    try { src.stop() } catch { /* already stopped */ }
    src.disconnect()
    sourceRef.current = null
    setFilePlaying(false)
  }

  function handleSpeak() {
    if (!speakText.trim() || speaking) return
    setError(null)
    const handle = speak(speakText)
    speakHandleRef.current = handle
    setSpeaking(true)
    handle.promise
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setSpeaking(false)
        speakHandleRef.current = null
      })
  }

  function handleStopSpeak() {
    speakHandleRef.current?.abort()
  }

  return (
    <div className="pointer-events-auto absolute bottom-4 right-4 flex w-80 flex-col gap-2 rounded-lg bg-black/60 p-3 text-xs backdrop-blur-sm">
      <div className="font-semibold opacity-80">Phase 3 · TTS + lip-sync</div>

      {status === 'idle' && (
        <button
          onClick={handleStart}
          className="rounded bg-cyan-600 px-3 py-1.5 font-medium text-white hover:bg-cyan-500"
        >
          Click to enable audio
        </button>
      )}

      {status === 'initializing' && <div className="opacity-70">Initializing…</div>}

      {status === 'error' && (
        <div className="max-w-full break-words text-rose-400">Error: {error}</div>
      )}

      {status === 'ready' && (
        <>
          <textarea
            value={speakText}
            onChange={(e) => setSpeakText(e.target.value)}
            rows={3}
            placeholder="Type something for her to say…"
            className="resize-none rounded bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none ring-1 ring-zinc-700 focus:ring-cyan-500"
          />

          <div className="flex gap-2">
            <button
              onClick={handleSpeak}
              disabled={!speakText.trim() || speaking}
              className="flex-1 rounded bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:opacity-40"
            >
              🗣 Speak
            </button>
            <button
              onClick={handleStopSpeak}
              disabled={!speaking}
              className="flex-1 rounded bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:opacity-40"
            >
              ■ Stop
            </button>
          </div>

          <div className="mt-1 flex items-center gap-2 border-t border-zinc-800 pt-2 opacity-70">
            <span className="text-[10px] uppercase tracking-wider">Phase 2 file</span>
            <label className="ml-auto flex cursor-pointer items-center gap-1 rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700">
              <span>📁 Load</span>
              <input type="file" accept="audio/*" onChange={handleFile} className="hidden" />
            </label>
          </div>
          {fileName && (
            <div className="flex items-center gap-2">
              <span className="max-w-[180px] truncate opacity-70">{fileName}</span>
              <div className="ml-auto flex gap-1">
                <button
                  onClick={handlePlayFile}
                  disabled={!bufferRef.current || filePlaying}
                  className="rounded bg-emerald-700 px-2 py-0.5 text-white hover:bg-emerald-600 disabled:opacity-40"
                >
                  ▶
                </button>
                <button
                  onClick={handleStopFile}
                  disabled={!filePlaying}
                  className="rounded bg-rose-700 px-2 py-0.5 text-white hover:bg-rose-600 disabled:opacity-40"
                >
                  ■
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="max-w-full break-words text-rose-400">{error}</div>
          )}
        </>
      )}
    </div>
  )
}
