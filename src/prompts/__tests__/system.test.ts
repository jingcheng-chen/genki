import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../system'

/**
 * System-prompt block-order tests — pinned after the Phase 11 TTFT work.
 *
 * The ordering is load-bearing: OpenRouter / xAI apply automatic prefix
 * caching when the leading section of the prompt is identical across
 * requests. Dynamic blocks (`memoryBlock`, `customInstructions`) must
 * stay at the tail or every turn busts the cache.
 */

const PERSONA = 'You are TestChar.'
const PROTOCOL_HEADING = '## Expressing emotion'
const RULES_HEADING = '## Rules'
const CUSTOM_HEADING = '## Personal notes from the user'
const MEMORY_HEADING = '## What you remember about them'

describe('buildSystemPrompt block order', () => {
  /**
   * @example
   *   persona text → emotion protocol heading → rules heading, with
   *   both customInstructions and memoryBlock appearing AFTER rules.
   */
  it('puts persona then static blocks (protocol + rules) before dynamic blocks', () => {
    const out = buildSystemPrompt({
      persona: PERSONA,
      customInstructions: 'Call me by my name.',
      memoryBlock: `${MEMORY_HEADING}\n\nAbout them:\n- likes tea.\n`,
      gestures: ['jump'],
      boundEmotions: ['happy'],
    })

    const idxPersona = out.indexOf(PERSONA)
    const idxProtocol = out.indexOf(PROTOCOL_HEADING)
    const idxRules = out.indexOf(RULES_HEADING)
    const idxCustom = out.indexOf(CUSTOM_HEADING)
    const idxMemory = out.indexOf(MEMORY_HEADING)

    expect(idxPersona).toBeGreaterThanOrEqual(0)
    expect(idxProtocol).toBeGreaterThan(idxPersona)
    expect(idxRules).toBeGreaterThan(idxProtocol)
    // Dynamic blocks must come AFTER the static rules heading, so the
    // persona→rules span is identical across turns and gets cached.
    expect(idxCustom).toBeGreaterThan(idxRules)
    expect(idxMemory).toBeGreaterThan(idxCustom)
  })

  /**
   * @example
   *   memory tail swapped between turns doesn't affect the leading
   *   persona+protocol+rules substring — that's exactly the prefix the
   *   provider caches.
   */
  it('keeps the leading persona + protocol + rules span stable regardless of memory', () => {
    const base = buildSystemPrompt({
      persona: PERSONA,
      memoryBlock: '',
    })
    const withMem = buildSystemPrompt({
      persona: PERSONA,
      memoryBlock: `${MEMORY_HEADING}\n\nAbout them:\n- likes tea.\n`,
    })
    const withOtherMem = buildSystemPrompt({
      persona: PERSONA,
      memoryBlock: `${MEMORY_HEADING}\n\nAbout them:\n- dislikes cilantro.\n`,
    })

    // Trim tail after the rules section — that tail is where dynamic
    // blocks live. Whatever remains must be byte-identical.
    const head = (s: string) => {
      // The rules section ends at "Reply in the same language the user is using."
      const marker = '- Reply in the same language the user is using.'
      const idx = s.indexOf(marker)
      return s.slice(0, idx + marker.length)
    }

    expect(head(base)).toBe(head(withMem))
    expect(head(base)).toBe(head(withOtherMem))
  })
})
