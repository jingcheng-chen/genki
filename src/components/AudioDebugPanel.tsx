import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { decodeAudioFile } from '../audio/context'
import {
  createPlaybackSource,
  ensureLipSyncDriver,
  getLipSyncDriver,
} from '../vrm/lip-sync-driver'

type Status = 'idle' | 'initializing' | 'ready' | 'error'

/**
 * Phase 2 debug overlay: upload any audio file, press play, the character's
 * mouth should track the syllables. Lives outside <Canvas> so it can use
 * ordinary DOM controls.
 */
export function AudioDebugPanel() {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)

  const bufferRef = useRef<AudioBuffer | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)

  // Always free the playing source on unmount so we don't leak a dangling
  // AudioWorklet connection.
  useEffect(() => {
    return () => {
      sourceRef.current?.stop()
      sourceRef.current?.disconnect()
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

  function handlePlay() {
    const driver = getLipSyncDriver()
    const buf = bufferRef.current
    if (!driver || !buf) return

    handleStop()

    const src = createPlaybackSource(buf, driver)
    src.onended = () => {
      setPlaying(false)
      driver.disconnectSource(src)
      sourceRef.current = null
    }
    src.start()
    sourceRef.current = src
    setPlaying(true)
  }

  function handleStop() {
    const src = sourceRef.current
    if (!src) return
    try { src.stop() } catch { /* already stopped */ }
    src.disconnect()
    sourceRef.current = null
    setPlaying(false)
  }

  return (
    <div className="pointer-events-auto absolute bottom-4 right-4 flex flex-col gap-2 rounded-lg bg-black/60 p-3 text-xs backdrop-blur-sm">
      <div className="font-semibold opacity-80">Phase 2 · lip-sync debug</div>

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
        <div className="max-w-xs text-rose-400">Error: {error}</div>
      )}

      {status === 'ready' && (
        <>
          <label className="flex cursor-pointer items-center gap-2 rounded bg-zinc-800 px-2 py-1.5 hover:bg-zinc-700">
            <span>📁 Load audio</span>
            <input
              type="file"
              accept="audio/*"
              onChange={handleFile}
              className="hidden"
            />
          </label>

          {fileName && (
            <div className="max-w-xs truncate opacity-70">{fileName}</div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handlePlay}
              disabled={!bufferRef.current || playing}
              className="flex-1 rounded bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:opacity-40"
            >
              ▶ Play
            </button>
            <button
              onClick={handleStop}
              disabled={!playing}
              className="flex-1 rounded bg-rose-600 px-3 py-1.5 font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:opacity-40"
            >
              ■ Stop
            </button>
          </div>

          {error && (
            <div className="max-w-xs text-rose-400">{error}</div>
          )}
        </>
      )}
    </div>
  )
}
