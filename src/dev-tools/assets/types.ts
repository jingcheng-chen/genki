/**
 * Wire types shared with `server/routes/dev-assets.ts`. Keep in sync — the
 * server file is the source of truth.
 */

export interface AssetEntry {
  name: string
  url: string
  sizeBytes: number
}

export interface CharacterSummary {
  id: string
  modelCount: number
  animationCount: number
  totalBytes: number
  previewUrl: string | null
}

export interface CharacterDetail {
  id: string
  previewUrl: string | null
  models: AssetEntry[]
  animations: AssetEntry[]
}

/**
 * Per-asset status, computed client-side by joining disk truth (the server
 * response) against the canonical preset roster (`STANDARD_ANIMATION_TEMPLATES`
 * + the active preset's `exclude` list).
 *
 * - `mapped`   — clip is on disk and registered in the preset
 * - `excluded` — clip is on disk and in the standard roster, but the preset
 *                explicitly excludes it (e.g. shiro / kissing)
 * - `orphan`   — clip is on disk but the standard roster doesn't reference
 *                this filename at all (likely a one-off the user dropped in)
 * - `missing`  — preset references a filename that has no matching disk file
 */
export type AnimationStatus = 'mapped' | 'excluded' | 'orphan' | 'missing'

export interface AnimationView extends AssetEntry {
  status: AnimationStatus
  /** Canonical id from the standard roster, when known. */
  templateId?: string
  /** Animation kind from the preset, when known. */
  kind?: 'idle' | 'idle_variant' | 'emotion' | 'gesture' | 'talking'
  /** Bound emotion from the preset, when known. */
  emotion?: string
}
