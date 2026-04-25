import { useState } from 'react'
import { resolveActiveModelId, useCharacterStore } from '../stores/character'
import { VRM_PRESETS, type VRMPreset } from '../vrm/presets'
import type { VRMModelVariant } from '../vrm/presets/types'

/**
 * Compact top-left panel for choosing between the bundled characters and
 * editing their per-character custom instructions.
 *
 * v1 scope (deliberately minimal):
 *   - Pick one of the bundled presets (Mika / Ani). No user-defined
 *     characters, no uploads, no voice editing.
 *   - Per-character textarea for custom instructions — appended to the
 *     persona by `buildSystemPrompt`. Persisted via the character store.
 *   - Switching characters clears the chat history (handled in ChatPanel).
 */
export function CharacterPicker() {
  const activePresetId = useCharacterStore((s) => s.activePresetId)
  const customInstructionsMap = useCharacterStore((s) => s.customInstructions)
  const setActive = useCharacterStore((s) => s.setActivePresetId)
  const setCustom = useCharacterStore((s) => s.setCustomInstructions)
  const setActiveModelId = useCharacterStore((s) => s.setActiveModelId)
  const activeModelId = useCharacterStore((s) =>
    resolveActiveModelId(s, s.activePresetId),
  )

  const [expanded, setExpanded] = useState(false)

  const active = VRM_PRESETS.find((p) => p.id === activePresetId) ?? VRM_PRESETS[0]
  const activeCustom = customInstructionsMap[active.id] ?? ''

  return (
    <div className="pointer-events-auto absolute left-4 top-4 flex w-72 flex-col gap-2 rounded-lg bg-black/60 p-3 text-sm text-zinc-100 backdrop-blur-sm">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-left"
      >
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider opacity-60">
            AI Companion · Phase 6
          </span>
          <span className="font-semibold">{active.name}</span>
        </div>
        <span className="ml-auto text-xs opacity-60">
          {expanded ? '▴' : '▾'}
        </span>
      </button>

      {expanded && (
        <>
          <div className="flex flex-col gap-1">
            {VRM_PRESETS.map((p) => (
              <PresetRow
                key={p.id}
                preset={p}
                active={p.id === activePresetId}
                onSelect={() => setActive(p.id)}
              />
            ))}
          </div>

          {active.models.length > 1 && (
            <div className="mt-1 flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wider opacity-60">
                Outfit — {active.name}
              </span>
              <OutfitPreview
                variant={
                  active.models.find((m) => m.id === activeModelId) ??
                  active.models[0]
                }
              />
              <div className="flex gap-1.5">
                {active.models.map((m) => (
                  <OutfitTile
                    key={m.id}
                    variant={m}
                    active={m.id === activeModelId}
                    onSelect={() => setActiveModelId(active.id, m.id)}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mt-1 flex flex-col gap-1">
            <label
              htmlFor="custom-instructions"
              className="text-[10px] uppercase tracking-wider opacity-60"
            >
              Custom instructions — {active.name}
            </label>
            <textarea
              id="custom-instructions"
              value={activeCustom}
              onChange={(e) => setCustom(active.id, e.target.value)}
              rows={4}
              placeholder="e.g. Always call me Captain."
              className="resize-none rounded bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none ring-1 ring-zinc-700 focus:ring-cyan-500"
            />
            <span className="text-[10px] opacity-50">
              Appended to the persona. Applied on the next turn — saved
              locally.
            </span>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Large display of the currently-selected outfit. Anchors the picker
 * visually so the user can read the outfit at a glance instead of
 * squinting at the thumbnail strip.
 */
function OutfitPreview({ variant }: { variant: VRMModelVariant }) {
  return (
    <div className="relative aspect-[3/4] w-full overflow-hidden rounded ring-1 ring-zinc-700">
      <img
        src={variant.previewUrl}
        alt={variant.label}
        className="h-full w-full object-cover"
      />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1.5">
        <div className="text-xs font-semibold text-zinc-100">
          {variant.label}
        </div>
        {variant.description && (
          <div className="text-[10px] leading-snug text-zinc-300">
            {variant.description}
          </div>
        )}
      </div>
    </div>
  )
}

function OutfitTile({
  variant,
  active,
  onSelect,
}: {
  variant: VRMModelVariant
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      title={variant.description ?? variant.label}
      className={[
        'group relative aspect-[3/4] flex-1 min-w-0 overflow-hidden rounded transition-all',
        active
          ? 'ring-2 ring-cyan-400'
          : 'opacity-60 ring-1 ring-zinc-700 hover:opacity-100',
      ].join(' ')}
    >
      <img
        src={variant.previewUrl}
        alt={variant.label}
        className="h-full w-full object-cover"
        loading="lazy"
      />
    </button>
  )
}

function PresetRow({
  preset,
  active,
  onSelect,
}: {
  preset: VRMPreset
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={[
        'flex flex-col rounded px-2 py-1.5 text-left transition-colors',
        active
          ? 'bg-cyan-700/60 ring-1 ring-cyan-400/50'
          : 'bg-zinc-900/70 hover:bg-zinc-800',
      ].join(' ')}
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold">
        <span className={active ? 'text-cyan-200' : 'opacity-50'}>
          {active ? '●' : '○'}
        </span>
        {preset.name}
      </span>
      <span className="pl-4 text-[11px] opacity-70">{preset.tagline}</span>
    </button>
  )
}
