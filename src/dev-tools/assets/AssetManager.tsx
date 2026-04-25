import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from './api'
import type {
  AnimationView,
  CharacterDetail,
  CharacterSummary,
} from './types'
import { CharacterList } from './CharacterList'
import { AssetList } from './AssetList'
import { PreviewPane } from './PreviewPane'
import { useTriageHotkeys } from './useTriageHotkeys'
import { buildAnimationViews } from './status'
import { captureScreenshot, makeScreenshotFilename } from './screenshot'

export function AssetManager() {
  const [characters, setCharacters] = useState<CharacterSummary[]>([])
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CharacterDetail | null>(null)
  const [selectedModelUrl, setSelectedModelUrl] = useState<string | null>(null)
  const [selectedAnimationUrl, setSelectedAnimationUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(true)
  const [loop, setLoop] = useState(true)
  const [globalError, setGlobalError] = useState<string | null>(null)

  // Initial + reload-driven character listing.
  const reloadCharacters = useCallback(async () => {
    try {
      const list = await api.listCharacters()
      setCharacters(list)
      setSelectedCharacterId((curr) => {
        if (curr && list.some((c) => c.id === curr)) return curr
        return list[0]?.id ?? null
      })
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    reloadCharacters()
  }, [reloadCharacters])

  // Re-fetch detail whenever the character changes, and reset selection.
  const reloadDetail = useCallback(async (id: string) => {
    try {
      const d = await api.getCharacter(id)
      setDetail(d)
      setSelectedModelUrl((curr) => {
        if (curr && d.models.some((m) => m.url === curr)) return curr
        return d.models[0]?.url ?? null
      })
      setSelectedAnimationUrl((curr) => {
        if (curr && d.animations.some((a) => a.url === curr)) return curr
        return null
      })
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    if (selectedCharacterId) reloadDetail(selectedCharacterId)
    else setDetail(null)
  }, [selectedCharacterId, reloadDetail])

  // Computed: animation views with status badges.
  const animationViews: AnimationView[] = useMemo(() => {
    if (!detail) return []
    return buildAnimationViews(detail.id, detail.animations)
  }, [detail])

  // Animation list for navigation hotkeys — only the entries the user can
  // actually play (skip 'missing' rows).
  const playableAnimations = useMemo(
    () => animationViews.filter((a) => a.status !== 'missing'),
    [animationViews],
  )

  const selectedAnimation = useMemo(
    () => animationViews.find((a) => a.url === selectedAnimationUrl) ?? null,
    [animationViews, selectedAnimationUrl],
  )

  // ---------------------------------------------------------------------------
  // Selection handlers.
  // ---------------------------------------------------------------------------

  const selectCharacter = useCallback((id: string) => {
    setSelectedCharacterId(id)
  }, [])

  const selectModel = useCallback((url: string) => {
    setSelectedModelUrl(url)
  }, [])

  const selectAnimation = useCallback((url: string) => {
    setSelectedAnimationUrl(url)
    setPlaying(true)
  }, [])

  const stepAnimation = useCallback(
    (dir: 1 | -1) => {
      if (playableAnimations.length === 0) return
      const idx = playableAnimations.findIndex((a) => a.url === selectedAnimationUrl)
      const nextIdx =
        idx < 0
          ? dir === 1
            ? 0
            : playableAnimations.length - 1
          : (idx + dir + playableAnimations.length) % playableAnimations.length
      setSelectedAnimationUrl(playableAnimations[nextIdx].url)
      setPlaying(true)
    },
    [playableAnimations, selectedAnimationUrl],
  )

  const togglePlaying = useCallback(() => setPlaying((p) => !p), [])
  const toggleLoop = useCallback(() => setLoop((l) => !l), [])

  // ---------------------------------------------------------------------------
  // Delete (with confirm). Optimistically removes from the detail; if the
  // server fails we refetch to recover.
  // ---------------------------------------------------------------------------
  const deleteUrl = useCallback(
    async (url: string) => {
      const filename = url.split('/').pop() ?? url
      if (!window.confirm(`Delete ${filename}?\n\nGit can recover it if this was a mistake.`)) {
        return
      }
      // Optimistic local removal so the list updates immediately.
      setDetail((d) =>
        d
          ? {
              ...d,
              models: d.models.filter((m) => m.url !== url),
              animations: d.animations.filter((a) => a.url !== url),
            }
          : d,
      )
      // If we deleted the currently-playing animation, advance the cursor.
      if (selectedAnimationUrl === url) {
        const idx = playableAnimations.findIndex((a) => a.url === url)
        const next = playableAnimations[idx + 1] ?? playableAnimations[idx - 1] ?? null
        setSelectedAnimationUrl(next?.url ?? null)
      }
      if (selectedModelUrl === url) {
        setSelectedModelUrl(null)
      }
      try {
        await api.deleteAsset(url)
      } catch (err) {
        setGlobalError(err instanceof Error ? err.message : String(err))
        // Rollback by re-fetching truth.
        if (selectedCharacterId) reloadDetail(selectedCharacterId)
      }
    },
    [
      playableAnimations,
      reloadDetail,
      selectedAnimationUrl,
      selectedCharacterId,
      selectedModelUrl,
    ],
  )

  const deleteCurrentAnimation = useCallback(() => {
    if (!selectedAnimationUrl) return
    deleteUrl(selectedAnimationUrl)
  }, [deleteUrl, selectedAnimationUrl])

  const reloadAll = useCallback(() => {
    reloadCharacters()
    if (selectedCharacterId) reloadDetail(selectedCharacterId)
  }, [reloadCharacters, reloadDetail, selectedCharacterId])

  const takeScreenshot = useCallback(async () => {
    if (!selectedModelUrl) return
    const filename = makeScreenshotFilename(selectedModelUrl, selectedAnimationUrl)
    const ok = await captureScreenshot(filename)
    if (!ok) setGlobalError('Screenshot failed (no active renderer)')
  }, [selectedModelUrl, selectedAnimationUrl])

  // ---------------------------------------------------------------------------
  // Hotkeys.
  // ---------------------------------------------------------------------------
  useTriageHotkeys(
    useMemo(
      () => ({
        onPrev: () => stepAnimation(-1),
        onNext: () => stepAnimation(1),
        onTogglePlaying: togglePlaying,
        onToggleLoop: toggleLoop,
        onDelete: deleteCurrentAnimation,
        onReload: reloadAll,
        onScreenshot: takeScreenshot,
      }),
      [
        stepAnimation,
        togglePlaying,
        toggleLoop,
        deleteCurrentAnimation,
        reloadAll,
        takeScreenshot,
      ],
    ),
  )

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[#0b0d12] text-[#e7e9ee]">
      <header className="px-4 py-2 border-b border-[#1f2230] flex items-center gap-3">
        <h1 className="text-sm font-semibold tracking-wide">VRM Asset Manager</h1>
        <span className="text-[11px] text-slate-500">
          {selectedCharacterId ? `· ${selectedCharacterId}` : ''}
          {selectedAnimation ? ` · ${selectedAnimation.name}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-slate-400">
          <KeyHint k="J/K">prev / next</KeyHint>
          <KeyHint k="Space">play</KeyHint>
          <KeyHint k="L">loop</KeyHint>
          <KeyHint k="D">delete</KeyHint>
          <KeyHint k="R">reload</KeyHint>
          <KeyHint k="S">save PNG</KeyHint>
          <button
            type="button"
            onClick={reloadAll}
            className="px-2 py-1 rounded border border-[#1f2230] hover:bg-[#1a1d2a] text-slate-300"
          >
            Reload
          </button>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-[200px_1fr_320px] min-h-0 overflow-hidden">
        <CharacterList
          characters={characters}
          selectedId={selectedCharacterId}
          onSelect={selectCharacter}
        />
        <PreviewPane
          vrmUrl={selectedModelUrl}
          animationUrl={selectedAnimationUrl}
          animationName={selectedAnimation?.name ?? null}
          playing={playing}
          loop={loop}
          onTogglePlaying={togglePlaying}
          onToggleLoop={toggleLoop}
          onPrev={() => stepAnimation(-1)}
          onNext={() => stepAnimation(1)}
          onScreenshot={takeScreenshot}
        />
        {detail ? (
          <AssetList
            models={detail.models}
            animations={animationViews}
            selectedModelUrl={selectedModelUrl}
            selectedAnimationUrl={selectedAnimationUrl}
            onSelectModel={selectModel}
            onSelectAnimation={selectAnimation}
            onDelete={deleteUrl}
          />
        ) : (
          <aside className="border-l border-[#1f2230] flex items-center justify-center text-slate-500 text-xs">
            {selectedCharacterId ? 'Loading…' : 'Pick a character'}
          </aside>
        )}
      </div>

      {globalError ? (
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-2 text-xs bg-rose-900/80 text-rose-100 border border-rose-700 rounded font-mono cursor-pointer"
          onClick={() => setGlobalError(null)}
          title="Click to dismiss"
        >
          {globalError}
        </div>
      ) : null}
    </div>
  )
}

function KeyHint({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="px-1.5 py-0.5 border border-[#1f2230] rounded bg-[#0e1119] font-mono text-[10px]">
        {k}
      </kbd>
      <span>{children}</span>
    </span>
  )
}
