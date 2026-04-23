import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_PRESET_ID } from '../vrm/presets'

/**
 * Minimal persisted state for Phase 6:
 *   - which character the user has selected
 *   - the per-character custom-instructions textarea contents
 *
 * Everything else (personas, voices, animations) lives in `presets.ts`
 * because it's code, not user state. Anything the user typed we keep so
 * it survives reloads and character switches.
 *
 * The map is keyed by preset id so switching between characters doesn't
 * clobber each other's overrides.
 */
interface CharacterState {
  activePresetId: string
  customInstructions: Record<string, string>
  setActivePresetId: (id: string) => void
  setCustomInstructions: (presetId: string, text: string) => void
}

export const useCharacterStore = create<CharacterState>()(
  persist(
    (set) => ({
      activePresetId: DEFAULT_PRESET_ID,
      customInstructions: {},
      setActivePresetId: (id) => set({ activePresetId: id }),
      setCustomInstructions: (presetId, text) =>
        set((state) => ({
          customInstructions: { ...state.customInstructions, [presetId]: text },
        })),
    }),
    // v1 key — bump the suffix if the shape changes (bigger than one key
    // in a map, or we rename `activePresetId`, etc.).
    { name: 'ai-companion-character-v1' },
  ),
)
