import { describe, expect, it } from 'vitest'
import { detectLanguage, resolveSessionLang } from '../language'
import type { VRMPreset } from '../../vrm/presets'

/**
 * Minimal preset stub — only the fields `resolveSessionLang` reads
 * (`defaultLanguage`). Everything else is left off-shape because the
 * resolver never touches it.
 */
function fakePreset(defaultLanguage: 'en-US' | 'zh-CN'): VRMPreset {
  return { defaultLanguage } as unknown as VRMPreset
}

describe('detectLanguage', () => {
  it('returns null for empty / whitespace input', () => {
    expect(detectLanguage('')).toBeNull()
    expect(detectLanguage('   ')).toBeNull()
  })

  it('returns zh-CN for pure Chinese text', () => {
    expect(detectLanguage('你好，今天天气真好。')).toBe('zh-CN')
    expect(detectLanguage('我在东京。')).toBe('zh-CN')
  })

  it('returns en-US for pure English text', () => {
    expect(detectLanguage('Hi, how are you?')).toBe('en-US')
    expect(detectLanguage("I live in Tokyo.")).toBe('en-US')
  })

  it('prefers zh-CN when both CJK and latin appear (code-mixing)', () => {
    // Chinese speaker code-switching is the common case; a single
    // ideograph dominates the signal.
    expect(detectLanguage('今天的 meeting 怎么样？')).toBe('zh-CN')
    expect(detectLanguage('Today我很累')).toBe('zh-CN')
  })

  it('returns null for numbers-only input', () => {
    expect(detectLanguage('12345')).toBeNull()
    expect(detectLanguage('  42  ')).toBeNull()
  })

  it('returns null for emoji-only / symbol-only input', () => {
    expect(detectLanguage('🎉🎂')).toBeNull()
    expect(detectLanguage('!!!')).toBeNull()
    expect(detectLanguage('???')).toBeNull()
  })

  it('handles short one-word turns', () => {
    expect(detectLanguage('ok')).toBe('en-US')
    expect(detectLanguage('好')).toBe('zh-CN')
  })
})

describe('resolveSessionLang', () => {
  it('priority 1: last user language wins over preset default', () => {
    expect(resolveSessionLang(fakePreset('en-US'), 'zh-CN')).toBe('zh-CN')
    expect(resolveSessionLang(fakePreset('zh-CN'), 'en-US')).toBe('en-US')
  })

  it('priority 2: preset default is the fallback when lastUserLang is null', () => {
    expect(resolveSessionLang(fakePreset('zh-CN'), null)).toBe('zh-CN')
    expect(resolveSessionLang(fakePreset('en-US'), null)).toBe('en-US')
  })
})
