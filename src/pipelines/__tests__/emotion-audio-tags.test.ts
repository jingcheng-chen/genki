import { describe, expect, it } from 'vitest'
import {
  createInlineAudioTagStripper,
  emotionAudioTag,
  INLINE_AUDIO_TAGS,
  stripInlineAudioTags,
} from '../emotion-audio-tags'

describe('emotionAudioTag', () => {
  it('maps each VRM primary and extended-vocab name to a bracket tag', () => {
    // Smoke-check a handful so a typo in the map shows up here before TTS.
    expect(emotionAudioTag('happy')).toBe('[happily]')
    expect(emotionAudioTag('excitement')).toBe('[excited]')
    expect(emotionAudioTag('shyness')).toBe('[shyly]')
    expect(emotionAudioTag('frustration')).toBe('[frustrated]')
  })

  it('returns null for neutral and unknown names', () => {
    expect(emotionAudioTag('neutral')).toBeNull()
    expect(emotionAudioTag('whatever')).toBeNull()
    expect(emotionAudioTag(null)).toBeNull()
    expect(emotionAudioTag(undefined)).toBeNull()
  })
})

describe('stripInlineAudioTags', () => {
  it('strips every whitelisted tag regardless of position', () => {
    for (const tag of INLINE_AUDIO_TAGS) {
      const wrapped = `hello [${tag}] world`
      expect(stripInlineAudioTags(wrapped)).toBe('hello world')
    }
  })

  it('leaves non-whitelisted bracket text alone (e.g. markdown-ish usage)', () => {
    // Future-proof: if someone writes "[see link]" in text it shouldn't be
    // mangled. Only the known vocabulary is touched.
    expect(stripInlineAudioTags('check [see link] please')).toBe(
      'check [see link] please',
    )
    expect(stripInlineAudioTags('[TODO] cleanup')).toBe('[TODO] cleanup')
  })

  it('handles tag at start / middle / end without leaving double spaces', () => {
    expect(stripInlineAudioTags('[softly] come here.')).toBe('come here.')
    expect(stripInlineAudioTags("that's [laughs] amazing.")).toBe(
      "that's amazing.",
    )
    expect(stripInlineAudioTags('that was wild. [sighs]')).toBe(
      'that was wild.',
    )
  })

  it('is case-insensitive', () => {
    expect(stripInlineAudioTags('oh [Whispers] hi')).toBe('oh hi')
    expect(stripInlineAudioTags('[LAUGHS SOFTLY] yeah')).toBe('yeah')
  })

  it('strips multiple tags in one string', () => {
    expect(
      stripInlineAudioTags('[thoughtfully] mm. [softly] okay.'),
    ).toBe('mm. okay.')
  })
})

describe('createInlineAudioTagStripper (streaming)', () => {
  it('strips a tag split across two deltas, emitting safely', () => {
    // Real-world split observed from Grok in dev.
    const s = createInlineAudioTagStripper()
    const emitted =
      s.push('Oh man, [laughs softl') +
      s.push('y] I wiped out') +
      s.flush()
    expect(emitted).toBe('Oh man, I wiped out')
  })

  it('strips a tag split across three deltas', () => {
    const s = createInlineAudioTagStripper()
    const emitted =
      s.push('that is [') +
      s.push('laughs') +
      s.push('] wild') +
      s.flush()
    expect(emitted).toBe('that is wild')
  })

  it('passes through text with no tags unchanged, no held suffix', () => {
    const s = createInlineAudioTagStripper()
    expect(s.push('hello ')).toBe('hello ')
    expect(s.push('world')).toBe('world')
    expect(s.flush()).toBe('')
  })

  it('holds unclosed bracket and emits verbatim on flush if never closed', () => {
    // Defensive: a broken tag from the LLM surfaces rather than silently
    // vanishing.
    const s = createInlineAudioTagStripper()
    expect(s.push('well [something')).toBe('well ')
    expect(s.flush()).toBe('[something')
  })

  it('handles multiple tags across many deltas', () => {
    const s = createInlineAudioTagStripper()
    const deltas = [
      '[thought',
      'fully] mm. ',
      "that's ",
      '[laughs] ',
      'not bad.',
    ]
    const emitted = deltas.map((d) => s.push(d)).join('') + s.flush()
    expect(emitted).toBe("mm. that's not bad.")
  })
})
