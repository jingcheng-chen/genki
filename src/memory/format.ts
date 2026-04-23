/**
 * Human-readable markdown serialization for the memory file.
 *
 * The file is the source of truth (IndexedDB stores the raw string;
 * an index is cached in-memory for retrieval). Each fact is a single
 * list line under a category heading.
 *
 * Line shape:
 *
 *   - [f_abc123] content here (i:0.80 · acc:3 · seen:2026-04-21T10:00:00Z
 *       · L1 · cat:preference · created:2026-04-20T00:00:00Z)
 *
 * Everything after the first "(" is a metadata tail; the parser tolerates
 * missing fields and malformed lines (skips them silently — a corrupted
 * line is better than a crash in the hot retrieval path).
 */

import type { Category, MemoryFact } from '../types/memory'
import { LOCAL_USER_ID, MAX_COMPRESSION_LEVEL } from '../types/memory'

const FILE_VERSION = 1

const CATEGORY_HEADINGS: Array<[Category, string]> = [
  ['durable', 'Durable'],
  ['relational', 'Relational'],
  ['preference', 'Preferences'],
  ['emotional', 'Emotional'],
  ['episodic', 'Episodic'],
]

const HEADING_BY_NAME: Record<string, Category> = Object.fromEntries(
  CATEGORY_HEADINGS.map(([cat, label]) => [label.toLowerCase(), cat]),
)

const CATEGORIES = new Set(CATEGORY_HEADINGS.map(([cat]) => cat))

/**
 * Escape regex metacharacters in a plain string. We only use this to
 * build the id-prefix matcher; it's narrow enough that a handful of
 * characters would suffice, but covering the full set is cheaper than
 * auditing future id shapes.
 */
function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Formats an ISO date for the on-disk view. The full ISO string is
 * kept for round-trip fidelity; reserve the old "2026-04-21" style
 * for debug UIs.
 */
function formatIso(d: string): string {
  return d
}

/**
 * Escapes parentheses in free-form fact content so the metadata tail
 * regex doesn't get confused. Escaped with backslash; the parser
 * unescapes.
 *
 * Before: "(noted in)" -> After: "\(noted in\)"
 */
function escapeContent(content: string): string {
  return content.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/**
 * Inverse of `escapeContent`. Leaves unknown backslash escapes alone
 * so pasted content with `\n` etc. is preserved verbatim.
 *
 * Before: "\\(noted in\\)" -> After: "(noted in)"
 */
function unescapeContent(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]
      if (next === '(' || next === ')' || next === '\\') {
        out += next
        i++
        continue
      }
    }
    out += c
  }
  return out
}

/**
 * Serializes an array of facts to the on-disk markdown format.
 *
 * Use when:
 * - Writing the memory file after extractor/compactor updates.
 * - Exporting memory for debugging.
 *
 * Expects:
 * - Facts may be in any order; they're sorted by category and then by
 *   createdAt before output for stable diffs.
 *
 * Returns:
 * - A full markdown string (header + sections). Ends with a trailing
 *   newline.
 */
export function stringifyMemoryMarkdown(
  facts: MemoryFact[],
  header: { characterId: string; userId?: string },
): string {
  const userId = header.userId ?? LOCAL_USER_ID
  const lines: string[] = [
    `<!-- memory-file-version: ${FILE_VERSION} -->`,
    `<!-- character: ${header.characterId} -->`,
    `<!-- user: ${userId} -->`,
    '',
  ]

  const byCategory = new Map<Category, MemoryFact[]>()
  for (const [cat] of CATEGORY_HEADINGS) byCategory.set(cat, [])
  for (const f of facts) {
    const bucket = byCategory.get(f.category)
    if (bucket) bucket.push(f)
  }

  for (const [cat, label] of CATEGORY_HEADINGS) {
    const bucket = byCategory.get(cat)!
    if (bucket.length === 0) continue
    bucket.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    lines.push(`## ${label}`)
    lines.push('')
    for (const fact of bucket) {
      lines.push(formatFactLine(fact))
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Emits a single fact list line, including the metadata tail.
 */
function formatFactLine(fact: MemoryFact): string {
  const parts = [
    `i:${fact.importance.toFixed(2)}`,
    `acc:${fact.accessCount}`,
    `seen:${formatIso(fact.lastAccessedAt)}`,
    `L${fact.compressionLevel}`,
    `cat:${fact.category}`,
    `created:${formatIso(fact.createdAt)}`,
  ]
  if (fact.sourceMessageIds.length > 0) {
    parts.push(`src:${fact.sourceMessageIds.join(',')}`)
  }
  return `- [${fact.id}] ${escapeContent(fact.content)} (${parts.join(' · ')})`
}

/**
 * Parses a memory markdown file back into facts.
 *
 * Use when:
 * - Loading the file from IndexedDB.
 * - Round-trip tests.
 *
 * Expects:
 * - Any string; malformed / unknown lines are skipped without throwing.
 *   The file header is optional — missing character/user fall back to
 *   empty string / LOCAL_USER_ID respectively.
 *
 * Returns:
 * - Array of facts in file order. Duplicates (same id) are de-duped
 *   last-wins so the caller doesn't need to.
 */
export function parseMemoryMarkdown(text: string): MemoryFact[] {
  if (!text) return []

  const lines = text.split(/\r?\n/)
  const byId = new Map<string, MemoryFact>()

  // NOTICE:
  // We derive characterId from the `<!-- character: X -->` header so
  // re-saving a loaded file doesn't lose the scoping. If the header is
  // missing (hand-edited files), we leave it empty — repo.load will
  // patch it on the way out. Root cause: users may edit the file by
  // hand; we tolerate their edits rather than crash.
  let headerCharacterId = ''
  let headerUserId: string = LOCAL_USER_ID

  let currentCategory: Category | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // Header comments
    const charMatch = /^<!--\s*character:\s*([^\s-][^-]*?)\s*-->/i.exec(line)
    if (charMatch) {
      headerCharacterId = charMatch[1].trim()
      continue
    }
    const userMatch = /^<!--\s*user:\s*([^\s-][^-]*?)\s*-->/i.exec(line)
    if (userMatch) {
      headerUserId = userMatch[1].trim() || LOCAL_USER_ID
      continue
    }
    if (/^<!--/.test(line)) continue

    // Section heading
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line)
    if (headingMatch) {
      const label = headingMatch[1].toLowerCase()
      const cat = HEADING_BY_NAME[label] ?? null
      currentCategory = cat
      continue
    }

    // List line — "- [id] content (metadata)"
    const listMatch = /^-\s+\[([a-z0-9_]+)\]\s+(.*)$/i.exec(line)
    if (!listMatch) continue

    const id = listMatch[1]
    const rest = listMatch[2]
    const metaIdx = findMetaStart(rest)
    const contentRaw = metaIdx < 0 ? rest : rest.slice(0, metaIdx).trimEnd()
    const metaBody = metaIdx < 0 ? '' : rest.slice(metaIdx + 1, rest.length - 1)
    const content = unescapeContent(contentRaw)

    const meta = parseMetaTail(metaBody)

    // Category: prefer an explicit `cat:` tag inside the metadata, fall
    // back to the enclosing section heading.
    const category: Category | null = meta.category ?? currentCategory
    if (!category || !CATEGORIES.has(category)) continue

    const fact: MemoryFact = {
      id,
      characterId: headerCharacterId,
      userId: headerUserId,
      content,
      category,
      createdAt: meta.createdAt ?? meta.lastAccessedAt ?? new Date(0).toISOString(),
      lastAccessedAt:
        meta.lastAccessedAt ?? meta.createdAt ?? new Date(0).toISOString(),
      accessCount: meta.accessCount ?? 0,
      importance: meta.importance ?? 0,
      compressionLevel: meta.compressionLevel ?? 0,
      sourceMessageIds: meta.sourceMessageIds ?? [],
    }
    byId.set(id, fact)
  }

  return Array.from(byId.values())
}

interface ParsedMeta {
  importance?: number
  accessCount?: number
  lastAccessedAt?: string
  createdAt?: string
  compressionLevel?: 0 | 1 | 2 | 3
  category?: Category
  sourceMessageIds?: string[]
}

/**
 * Finds the `(` that starts the metadata tail, respecting backslash
 * escapes inside content (so "\(" is part of the content, not a tail).
 *
 * Returns the index of the opening paren whose matching close is the
 * LAST char of `rest`. Returns -1 if no such tail exists.
 */
function findMetaStart(rest: string): number {
  if (!rest.endsWith(')')) return -1
  let depth = 0
  for (let i = rest.length - 1; i >= 0; i--) {
    const c = rest[i]
    // Check for backslash escape
    if (i > 0 && rest[i - 1] === '\\') continue
    if (c === ')') depth++
    else if (c === '(') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Parses the metadata body "i:0.8 · acc:3 · seen:…" into a structured
 * shape. Unknown keys are ignored.
 */
function parseMetaTail(body: string): ParsedMeta {
  const out: ParsedMeta = {}
  if (!body) return out
  const parts = body.split('·').map((p) => p.trim()).filter(Boolean)
  for (const part of parts) {
    const colonIdx = part.indexOf(':')
    if (colonIdx < 0) {
      // Shorthand `L1`/`L2`/`L3`
      const m = /^L([0-3])$/.exec(part)
      if (m) out.compressionLevel = Number(m[1]) as 0 | 1 | 2 | 3
      continue
    }
    const key = part.slice(0, colonIdx).trim().toLowerCase()
    const value = part.slice(colonIdx + 1).trim()
    switch (key) {
      case 'i':
      case 'importance': {
        const n = Number(value)
        if (Number.isFinite(n)) out.importance = Math.max(0, Math.min(1, n))
        break
      }
      case 'acc':
      case 'access': {
        const n = Number(value)
        if (Number.isFinite(n)) out.accessCount = Math.max(0, Math.floor(n))
        break
      }
      case 'seen':
      case 'last': {
        if (value) out.lastAccessedAt = value
        break
      }
      case 'created': {
        if (value) out.createdAt = value
        break
      }
      case 'l':
      case 'level': {
        const n = Number(value)
        if (n === 0 || n === 1 || n === 2 || n === 3) {
          out.compressionLevel = n as 0 | 1 | 2 | 3
        }
        break
      }
      case 'cat':
      case 'category': {
        if (CATEGORIES.has(value as Category)) out.category = value as Category
        break
      }
      case 'src':
      case 'source': {
        if (value) out.sourceMessageIds = value.split(',').map((s) => s.trim())
        break
      }
      default:
        break
    }
  }
  if (out.compressionLevel !== undefined) {
    const cl = out.compressionLevel
    out.compressionLevel = Math.max(
      0,
      Math.min(MAX_COMPRESSION_LEVEL, cl),
    ) as 0 | 1 | 2 | 3
  }
  return out
}

/** Exposed for tests so we don't have to construct full files just to hit
 *  the metadata parser. Not exported as a public API. */
export const _internalForTests = {
  parseMetaTail,
  findMetaStart,
  escapeContent,
  unescapeContent,
  escapeRegex,
}
