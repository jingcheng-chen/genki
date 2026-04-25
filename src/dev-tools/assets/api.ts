import type { CharacterDetail, CharacterSummary } from './types'

/**
 * Tiny typed client for `/api/dev/assets/*`. Throws on non-2xx with the
 * server's error string so callers get a useful toast.
 */

export async function listCharacters(): Promise<CharacterSummary[]> {
  const r = await fetch('/api/dev/assets/characters')
  const body = await readJson<{ characters: CharacterSummary[] }>(r)
  return body.characters
}

export async function getCharacter(id: string): Promise<CharacterDetail> {
  const r = await fetch(`/api/dev/assets/characters/${encodeURIComponent(id)}`)
  return readJson<CharacterDetail>(r)
}

export async function deleteAsset(url: string): Promise<void> {
  const r = await fetch('/api/dev/assets/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  await readJson<{ ok: true }>(r)
}

async function readJson<T>(r: Response): Promise<T> {
  const text = await r.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${r.status}: ${text || r.statusText}`)
  }
  if (!r.ok) {
    const msg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : r.statusText
    throw new Error(`HTTP ${r.status}: ${msg}`)
  }
  return parsed as T
}
