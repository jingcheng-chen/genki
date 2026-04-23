import { useState } from 'react'
import { useCharacterStore } from '../stores/character'
import { useSceneStore, type SceneStatus } from '../stores/scene'
import { getPreset, VRM_PRESETS } from '../vrm/presets'
import { ensureLipSyncDriver } from '../vrm/lip-sync-driver'

/**
 * Phase 10 — The welcome modal that gates audio-context resume behind a
 * user gesture and shows which character the user is about to wake up.
 *
 * State flow:
 *
 *   idle / rehydrating        (mount; show dim welcome text)
 *   loading-vrm               (VRM + VRMA download; show progress bar)
 *   binding                   (animation controller builds; should be <1 frame)
 *   ready                     (everything parsed, waiting for Start click)
 *   audio-initializing        (user clicked; wlipsync + AudioContext.resume)
 *                             once this completes we flip the gate's visibility
 *                             off via the local `hidden` state
 *   error                     (fatal; retry button)
 *
 * Design constraints:
 *  - Backdrop is a subtle blur, not an opaque black — the 3D scene peeks
 *    through so it feels like a real preview of the character.
 *  - After a successful dismiss in the current session we DO NOT re-show
 *    the gate on re-mounts within that session.
 */

/** Visibility phases the gate uses for its cross-fade dismiss. */
type GateVisibility = 'visible' | 'fading' | 'hidden'

export function StartGate() {
  const hasHydrated = useCharacterStore((s) => s.hasHydrated)
  const activePresetId = useCharacterStore((s) => s.activePresetId)
  const setActivePresetId = useCharacterStore((s) => s.setActivePresetId)

  const status = useSceneStore((s) => s.status)
  const vrmProgress = useSceneStore((s) => s.vrmProgress)
  const errorMessage = useSceneStore((s) => s.errorMessage)
  const setStatus = useSceneStore((s) => s.setStatus)
  const setError = useSceneStore((s) => s.setError)
  const setAudioInitialized = useSceneStore((s) => s.setAudioInitialized)
  const reset = useSceneStore((s) => s.reset)

  // Once the user successfully starts, we hide the gate for the rest of
  // the session. If they reload, we're back to square one (which is
  // correct — AudioContext requires a fresh user gesture per document).
  const [visibility, setVisibility] = useState<GateVisibility>('visible')

  const preset = hasHydrated ? getPreset(activePresetId) : null

  async function handleStart() {
    // Guard: only meaningful to run once per session. If the user somehow
    // got here with status already mid-audio-init, bail.
    if (status === 'audio-initializing') return

    setStatus('audio-initializing')
    try {
      // ensureLipSyncDriver itself calls resumeAudioContext under the hood,
      // so one await handles both the WebAudio gesture and the wlipsync
      // bootstrap (WASM compile + worklet registration).
      await ensureLipSyncDriver()
      // Mark the lip-sync driver as bound so downstream consumers
      // (ChatPanel greeting effect, etc.) can distinguish "ready after
      // VRM parse" from "ready after audio init" — both land on
      // status === 'ready' in the state machine.
      setAudioInitialized()
      // Flip back to `ready` so ChatPanel un-dims. Kick off fade-out
      // simultaneously — the gate is about to unmount anyway, so the
      // button label briefly reverting is hidden by the fade.
      setStatus('ready')
      setVisibility('fading')
      setTimeout(() => setVisibility('hidden'), 160)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(`Audio init failed: ${message}`)
    }
  }

  function handleRetry() {
    reset()
    // Force a reload for a clean VRM fetch too — a failed VRM network
    // request leaves R3F's useLoader cache with a rejected promise that's
    // hard to clear without a full remount.
    window.location.reload()
  }

  if (visibility === 'hidden') return null

  const isReady = status === 'ready'
  const isBooting =
    !hasHydrated || status === 'idle' || status === 'rehydrating'
  const isError = status === 'error'

  const progressCopy = getProgressCopy(status, preset?.name)

  return (
    <div
      className={[
        'fixed inset-0 z-30 flex items-center justify-center',
        'bg-black/35 backdrop-blur-md',
        'transition-opacity duration-150 ease-out',
        visibility === 'fading' ? 'opacity-0' : 'opacity-100',
      ].join(' ')}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome"
    >
      <div
        className={[
          'flex w-[min(24rem,92vw)] flex-col items-center gap-4 rounded-2xl',
          'bg-zinc-950/80 p-6 text-center shadow-2xl ring-1 ring-zinc-800',
        ].join(' ')}
      >
        {preset ? (
          <>
            <CharacterHero
              name={preset.name}
              tagline={preset.tagline}
              previewUrl={preset.previewUrl}
            />
            {/* Let the user swap character BEFORE waking things up, so
                they're not forced to start the default first. */}
            {VRM_PRESETS.length > 1 && (
              <div className="flex flex-wrap justify-center gap-2">
                {VRM_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setActivePresetId(p.id)}
                    disabled={status === 'audio-initializing'}
                    className={[
                      'rounded-full px-3 py-1 text-[11px] font-medium transition-colors',
                      p.id === activePresetId
                        ? 'bg-cyan-700 text-white ring-1 ring-cyan-400/50'
                        : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700',
                      'disabled:cursor-not-allowed disabled:opacity-40',
                    ].join(' ')}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <WelcomeStub />
        )}

        <ProgressReadout
          copy={progressCopy}
          status={status}
          progress={vrmProgress}
        />

        {isError && (
          <div className="break-words text-xs text-rose-300">
            {errorMessage ?? 'Something went wrong.'}
          </div>
        )}

        {isError ? (
          <button
            onClick={handleRetry}
            className={[
              'rounded-lg bg-rose-600 px-5 py-2 text-sm font-semibold text-white',
              'hover:bg-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-300',
            ].join(' ')}
          >
            Retry
          </button>
        ) : (
          <button
            onClick={handleStart}
            disabled={!isReady || isBooting}
            className={[
              'rounded-lg px-5 py-2 text-sm font-semibold text-white transition-colors',
              isReady
                ? 'bg-cyan-600 hover:bg-cyan-500'
                : 'bg-zinc-700 text-zinc-400',
              'focus:outline-none focus:ring-2 focus:ring-cyan-300',
              'disabled:cursor-not-allowed',
            ].join(' ')}
          >
            {status === 'audio-initializing' ? 'Waking up…' : 'Start conversation'}
          </button>
        )}

        <div className="text-[10px] opacity-40">
          Microphone access prompts after Start. You can also just type.
        </div>
      </div>
    </div>
  )
}

function CharacterHero({
  name,
  tagline,
  previewUrl,
}: {
  name: string
  tagline: string
  previewUrl: string
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      {/* Avatar preview — fall back to a soft gradient silhouette if the
          bundled preview.png is missing/404. onError swaps to display:none
          so the layout stays stable. */}
      <img
        src={previewUrl}
        alt={`${name} portrait`}
        className="h-20 w-20 rounded-full object-cover ring-2 ring-cyan-500/40"
        onError={(e) => {
          const img = e.currentTarget
          img.style.display = 'none'
        }}
      />
      <div className="flex flex-col items-center">
        <div className="text-lg font-semibold">{name}</div>
        <div className="mt-0.5 text-xs opacity-70">{tagline}</div>
      </div>
    </div>
  )
}

function WelcomeStub() {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="text-lg font-semibold">Welcome</div>
      <div className="text-xs opacity-60">Loading your companion…</div>
    </div>
  )
}

function ProgressReadout({
  copy,
  status,
  progress,
}: {
  copy: string
  status: SceneStatus
  progress: number
}) {
  const showBar = status === 'loading-vrm' || status === 'binding'
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="text-center text-xs opacity-70">{copy}</div>
      {showBar && (
        <div className="h-1 w-full overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full bg-cyan-500 transition-[width] duration-150"
            style={{
              width: `${Math.max(0.06, status === 'binding' ? 1 : progress) * 100}%`,
            }}
          />
        </div>
      )}
    </div>
  )
}

function getProgressCopy(status: SceneStatus, name: string | undefined): string {
  const who = name ?? 'your companion'
  switch (status) {
    case 'idle':
    case 'rehydrating':
      return `Warming up ${who}…`
    case 'loading-vrm':
      return `Loading ${who}…`
    case 'binding':
      return `Tuning ${who}'s voice…`
    case 'audio-initializing':
      return 'Opening the mic line…'
    case 'ready':
      return 'Ready when you are.'
    case 'error':
      return "Couldn't start."
  }
}
