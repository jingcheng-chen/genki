import type { Lang, VRMPreset } from '../vrm/presets'

/**
 * Pure language helpers for the greeting pipeline.
 *
 * Scope: pick a language for an OUTGOING greeting based on (in priority order)
 *   1. what the user's last turn looked like (`lastUserLang` in the store),
 *   2. the active preset's `defaultLanguage`.
 *
 * `navigator.language` is intentionally NOT in this chain. The preset's
 * `defaultLanguage` is an authored design choice — a character with
 * `defaultLanguage: 'zh-CN'` is meant to speak Chinese on first meet,
 * regardless of which browser the user happens to be on. The user's
 * actual language shows up via `lastUserLang` after their first turn.
 *
 * We also expose a cheap regex-based sniffer used after every user turn to
 * update `lastUserLang`. It is deliberately simple — anything ambiguous
 * returns `null` so the caller leaves the previous value alone instead of
 * flipping on noise (numbers, emoji, "ok", …).
 */

// CJK Unified Ideographs + CJK Extension A + punctuation. Anything in
// these blocks is unambiguously Chinese/Japanese-adjacent for our purposes;
// the only supported CJK language is zh-CN, so a hit maps there.
const CJK_REGEX = /[㐀-䶿一-鿿]/
// Latin letters (A-Z / a-z plus common European accents). We only flip to
// 'en-US' when we see real letters — a pure-number / pure-punctuation
// transcript shouldn't nudge the language.
const LATIN_REGEX = /[A-Za-zÀ-ɏ]/

/**
 * Sniff the probable language of a user message. Returns null when the
 * signal is too weak to update state (empty, emoji-only, numbers-only, etc.).
 *
 * Mixed CJK + Latin is treated as Chinese — the user writing "今天的 meeting
 * 怎么样" is almost certainly a Chinese speaker code-mixing English terms,
 * not an English speaker who typed one ideograph.
 */
export function detectLanguage(text: string): Lang | null {
  if (!text) return null
  if (CJK_REGEX.test(text)) return 'zh-CN'
  if (LATIN_REGEX.test(text)) return 'en-US'
  return null
}

/**
 * Full resolver used by the greeting pipeline. Priority:
 *   lastUserLang  →  preset.defaultLanguage
 *
 * `lastUserLang` is the strongest signal — the user was literally speaking
 * that language last. Preset default is the intentional backstop and
 * always yields a concrete language, so this function cannot return null.
 */
export function resolveSessionLang(
  preset: VRMPreset,
  lastUserLang: Lang | null,
): Lang {
  if (lastUserLang) return lastUserLang
  return preset.defaultLanguage
}

/** Friendly name inserted into the greeting's session-context block. */
export function langFriendlyName(lang: Lang): string {
  if (lang === 'zh-CN') return 'Simplified Chinese (普通话)'
  return 'English'
}
