import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_PRESET_ID } from '../vrm/presets'
import type { Lang } from '../vrm/presets'

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
 *
 * Phase 10 audit:
 *   Zustand `persist` middleware hydrates SYNCHRONOUSLY from localStorage
 *   on store creation (no async callback — it's plain `localStorage.getItem`
 *   during the `create()` call). The first React render therefore already
 *   sees the restored `activePresetId`, and there is no Mika-then-Ani flash
 *   on reload.
 *
 *   We still expose `hasHydrated` so the StartGate can distinguish "boot in
 *   progress" from "ready to pick a character" in the same render cycle. The
 *   flag flips to true once `onRehydrateStorage` finishes, which happens
 *   before the first render anyway — but having the flag makes the intent
 *   explicit and keeps us safe if Zustand ever flips the default to async.
 */
interface CharacterState {
  activePresetId: string
  customInstructions: Record<string, string>
  /**
   * How many times a greeting has been played for each preset, across all
   * page loads. 0 = never → pick a starter; >= 1 → pick a returner. Drives
   * the same "first-meeting vs. welcome-back" distinction as the reference
   * Statsig config (`starters` vs `returners` in `ani.reference.yml`).
   *
   * Missing keys (new preset added in a later build) are treated as 0 by
   * the reader, so we don't need a migration when the preset registry
   * grows.
   */
  greetedPresets: Record<string, number>
  /**
   * Last-observed user language, sniffed cheaply from the user's
   * transcript/input after each turn (CJK → 'zh-CN', latin → 'en-US'). Used
   * by the greeting pipeline to decide which language to open the next
   * session in. `null` = no signal yet; resolver falls through to
   * navigator.language and finally the preset's `defaultLanguage`.
   *
   * Shared across characters by design — if the user just spent a session
   * speaking Chinese with Mika, Ani should open in Chinese too rather than
   * resetting to per-preset defaults.
   */
  lastUserLang: Lang | null
  /** True once persist middleware has finished loading from localStorage.
   *  Consumers (StartGate) can treat this as the gate for "know which
   *  character to render". */
  hasHydrated: boolean
  setActivePresetId: (id: string) => void
  setCustomInstructions: (presetId: string, text: string) => void
  recordGreeting: (presetId: string) => void
  setLastUserLang: (lang: Lang) => void
  setHasHydrated: (v: boolean) => void
}

export const useCharacterStore = create<CharacterState>()(
  persist(
    (set) => ({
      activePresetId: DEFAULT_PRESET_ID,
      customInstructions: {},
      greetedPresets: {},
      lastUserLang: null,
      // Zustand's persist middleware sets this synchronously below during
      // onRehydrateStorage's finish callback. Start true-adjacent-to-load
      // so the UI doesn't block on an empty cache.
      hasHydrated: false,
      setActivePresetId: (id) => set({ activePresetId: id }),
      setCustomInstructions: (presetId, text) =>
        set((state) => ({
          customInstructions: { ...state.customInstructions, [presetId]: text },
        })),
      recordGreeting: (presetId) =>
        set((state) => {
          const prev = state.greetedPresets[presetId] ?? 0
          return {
            greetedPresets: { ...state.greetedPresets, [presetId]: prev + 1 },
          }
        }),
      setLastUserLang: (lang) => set({ lastUserLang: lang }),
      setHasHydrated: (v) => set({ hasHydrated: v }),
    }),
    {
      // v1 key — bump the suffix if the shape changes (bigger than one key
      // in a map, or we rename `activePresetId`, etc.). Adding a new field
      // (greetedPresets) is a widening change: existing users rehydrate
      // with the key missing, so `greetedPresets ?? {}` at read time keeps
      // us compatible without a version bump.
      name: 'ai-companion-character-v1',
      // Exclude the hydration flag from the serialized state so it always
      // starts false and flips true after restoration. Everything else
      // round-trips by default.
      partialize: (state) => ({
        activePresetId: state.activePresetId,
        customInstructions: state.customInstructions,
        greetedPresets: state.greetedPresets,
        lastUserLang: state.lastUserLang,
      }),
      onRehydrateStorage: () => (state, error) => {
        // If rehydrate errored (quota exceeded, private mode, …), we
        // still want to proceed with defaults rather than hang the UI.
        if (error) {
          console.warn('[character-store] rehydrate failed', error)
        }
        state?.setHasHydrated(true)
      },
    },
  ),
)
