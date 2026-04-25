import {
  STANDARD_ANIMATION_TEMPLATES,
  type AnimationTemplate,
} from '../../vrm/presets/animations'
import { VRM_PRESETS } from '../../vrm/presets'
import type { AnimationView, AssetEntry } from './types'

/**
 * Join the disk listing (server response) against the canonical roster
 * (`STANDARD_ANIMATION_TEMPLATES`) and the active preset's `animations`
 * list to assign a `status` to every animation entry the user might care
 * about.
 *
 * Output ordering — preset-mapped first (in preset order), then excluded,
 * orphan, and missing. That mirrors how a triage user wants to see them:
 * "things that are wired up" → "things wired up but suppressed" →
 * "extras" → "broken refs."
 */
export function buildAnimationViews(
  characterId: string,
  diskAnimations: AssetEntry[],
): AnimationView[] {
  const preset = VRM_PRESETS.find((p) => p.id === characterId)

  // filename → preset entry (for the active character only)
  const presetByFilename = new Map<
    string,
    { kind: AnimationView['kind']; emotion?: string; templateId: string }
  >()
  if (preset) {
    for (const a of preset.animations) {
      const filename = a.url.split('/').pop() ?? a.url
      presetByFilename.set(filename, {
        kind: a.kind,
        emotion: a.emotion,
        templateId: a.id,
      })
    }
  }

  // filename → standard template (the full unfiltered roster)
  const standardByFilename = new Map<string, AnimationTemplate>()
  for (const t of STANDARD_ANIMATION_TEMPLATES) {
    standardByFilename.set(t.filename, t)
  }

  const seenFilenames = new Set<string>()
  const out: AnimationView[] = []

  for (const a of diskAnimations) {
    seenFilenames.add(a.name)
    const presetMatch = presetByFilename.get(a.name)
    if (presetMatch) {
      out.push({
        ...a,
        status: 'mapped',
        kind: presetMatch.kind,
        emotion: presetMatch.emotion,
        templateId: presetMatch.templateId,
      })
      continue
    }
    const standardMatch = standardByFilename.get(a.name)
    if (standardMatch) {
      out.push({
        ...a,
        status: 'excluded',
        kind: standardMatch.kind,
        emotion: standardMatch.emotion,
        templateId: standardMatch.id,
      })
      continue
    }
    out.push({ ...a, status: 'orphan' })
  }

  // Preset entries the disk doesn't have a file for.
  if (preset) {
    for (const a of preset.animations) {
      const filename = a.url.split('/').pop() ?? a.url
      if (seenFilenames.has(filename)) continue
      out.push({
        name: filename,
        url: a.url,
        sizeBytes: 0,
        status: 'missing',
        kind: a.kind,
        emotion: a.emotion,
        templateId: a.id,
      })
    }
  }

  // Stable triage order: mapped (in preset order) → excluded → orphan → missing.
  const rank: Record<AnimationView['status'], number> = {
    mapped: 0,
    excluded: 1,
    orphan: 2,
    missing: 3,
  }
  out.sort((a, b) => {
    const r = rank[a.status] - rank[b.status]
    if (r !== 0) return r
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })

  return out
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
