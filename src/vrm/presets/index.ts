/**
 * VRM preset registry.
 *
 * Each character's full configuration lives in its own file next to this
 * one (`mika.ts`, `ani.ts`, `shiro.ts`). Add a new character by:
 *
 *   1. Drop assets into `/public/vrm/<id>/` with the layout:
 *        /public/vrm/<id>/models/<variant>.vrm     (one or more)
 *        /public/vrm/<id>/animations/<clip>.vrma
 *        /public/vrm/<id>/preview.(png|jpg)
 *   2. Create `src/vrm/presets/<id>.ts` exporting a `VRMPreset`.
 *   3. Import it here and append to `VRM_PRESETS`.
 *
 * The first preset in the array is the default on a fresh install.
 */

import type { VRMPreset } from './types'
import { mika } from './mika'
import { ani } from './ani'
import { shiro } from './shiro'

export type { VRMModelVariant, VRMAnimationEntry, VRMPreset } from './types'

export const VRM_PRESETS: VRMPreset[] = [mika, ani, shiro]

export const DEFAULT_PRESET_ID = VRM_PRESETS[0].id

export function getPreset(id: string): VRMPreset {
  const preset = VRM_PRESETS.find((p) => p.id === id)
  if (!preset) throw new Error(`[presets] unknown preset id: ${id}`)
  return preset
}

/**
 * Resolve the VRM url for a given preset + optional outfit variant.
 *
 * When `modelId` is omitted we return the preset's `defaultModelId` url —
 * that's what callers want today. A future outfit-swap UI (or a romance-
 * meter unlock from the reference config's `hiddenGoals`) will pass an
 * explicit id.
 *
 * Throws for unknown variants rather than silently falling back — a
 * mistyped id during authoring should fail loudly, not quietly load the
 * wrong outfit.
 */
export function getModelUrl(preset: VRMPreset, modelId?: string): string {
  const id = modelId ?? preset.defaultModelId
  const m = preset.models.find((v) => v.id === id)
  if (!m) {
    throw new Error(
      `[presets] preset "${preset.id}" has no model variant "${id}" ` +
        `(available: ${preset.models.map((v) => v.id).join(', ')})`,
    )
  }
  return m.url
}
