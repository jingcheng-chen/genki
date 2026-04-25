import { Hono } from 'hono'
import { readdir, realpath, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

/**
 * Dev-only asset manager API.
 *
 * Mounted by `server/index.ts` only when `NODE_ENV !== 'production'`. Walks
 * `<repo>/public/vrm/<character>/{models,animations}/` and exposes simple
 * list + hard-delete endpoints used by `dev/assets.html`.
 *
 * Hard delete (no trash dir) is intentional — the user keeps their own git
 * history as the safety net.
 */

const REPO_ROOT = path.resolve(process.cwd())
const VRM_ROOT = path.resolve(REPO_ROOT, 'public', 'vrm')
const URL_PREFIX = '/vrm/'
const ALLOWED_EXT = new Set(['.vrm', '.vrma'])
const PREVIEW_NAMES = ['preview.png', 'preview.jpg', 'preview.webp']

interface AssetEntry {
  name: string
  url: string
  sizeBytes: number
}

interface CharacterSummary {
  id: string
  modelCount: number
  animationCount: number
  totalBytes: number
  previewUrl: string | null
}

interface CharacterDetail {
  id: string
  previewUrl: string | null
  models: AssetEntry[]
  animations: AssetEntry[]
}

const devAssets = new Hono()

devAssets.get('/characters', async (c) => {
  try {
    const entries = await readdir(VRM_ROOT, { withFileTypes: true })
    const summaries: CharacterSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
      summaries.push(await summarizeCharacter(entry.name))
    }
    summaries.sort((a, b) => a.id.localeCompare(b.id))
    return c.json({ characters: summaries })
  } catch (err) {
    return c.json({ error: errMsg(err) }, 500)
  }
})

devAssets.get('/characters/:id', async (c) => {
  const id = c.req.param('id')
  if (!isSafeCharacterId(id)) {
    return c.json({ error: 'invalid character id' }, 400)
  }
  const charDir = path.join(VRM_ROOT, id)
  try {
    const s = await stat(charDir)
    if (!s.isDirectory()) return c.json({ error: 'not a character directory' }, 404)
  } catch {
    return c.json({ error: 'character not found' }, 404)
  }
  try {
    const detail: CharacterDetail = {
      id,
      previewUrl: await findPreviewUrl(id),
      models: await listAssets(id, 'models'),
      animations: await listAssets(id, 'animations'),
    }
    return c.json(detail)
  } catch (err) {
    return c.json({ error: errMsg(err) }, 500)
  }
})

devAssets.post('/delete', async (c) => {
  let body: { url?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }

  const raw = typeof body.url === 'string' ? body.url : ''
  if (!raw) return c.json({ error: 'missing "url"' }, 400)

  let resolved: string
  try {
    resolved = await resolveAssetPath(raw)
  } catch (err) {
    return c.json({ error: errMsg(err) }, 400)
  }

  try {
    await unlink(resolved)
    return c.json({ ok: true, deletedUrl: raw })
  } catch (err) {
    return c.json({ error: errMsg(err) }, 500)
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function summarizeCharacter(id: string): Promise<CharacterSummary> {
  const models = await listAssets(id, 'models')
  const animations = await listAssets(id, 'animations')
  const totalBytes =
    models.reduce((s, e) => s + e.sizeBytes, 0) +
    animations.reduce((s, e) => s + e.sizeBytes, 0)
  return {
    id,
    modelCount: models.length,
    animationCount: animations.length,
    totalBytes,
    previewUrl: await findPreviewUrl(id),
  }
}

async function listAssets(
  characterId: string,
  subdir: 'models' | 'animations',
): Promise<AssetEntry[]> {
  const dir = path.join(VRM_ROOT, characterId, subdir)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: AssetEntry[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const ext = path.extname(e.name).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) continue
    const full = path.join(dir, e.name)
    const s = await stat(full)
    out.push({
      name: e.name,
      url: `${URL_PREFIX}${characterId}/${subdir}/${e.name}`,
      sizeBytes: s.size,
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return out
}

async function findPreviewUrl(characterId: string): Promise<string | null> {
  const dir = path.join(VRM_ROOT, characterId)
  for (const name of PREVIEW_NAMES) {
    try {
      await stat(path.join(dir, name))
      return `${URL_PREFIX}${characterId}/${name}`
    } catch {
      // try the next preview name
    }
  }
  return null
}

function isSafeCharacterId(id: string): boolean {
  // Plain alphanumerics + underscores + hyphens. No dots, no slashes.
  return /^[a-z0-9_-]+$/i.test(id)
}

/**
 * Validate a `/vrm/<char>/<subdir>/<file>` URL and return the absolute path
 * on disk. Throws on anything fishy. Realpath-checked so symlinks can't
 * point outside the public/vrm root.
 */
async function resolveAssetPath(url: string): Promise<string> {
  if (!url.startsWith(URL_PREFIX)) {
    throw new Error(`url must start with ${URL_PREFIX}`)
  }
  const rel = url.slice(URL_PREFIX.length).replace(/^\/+/, '')
  if (rel.includes('..') || rel.includes('\0')) {
    throw new Error('illegal characters in path')
  }
  const ext = path.extname(rel).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`extension ${ext || '(none)'} not allowed`)
  }
  const resolved = path.resolve(VRM_ROOT, rel)
  if (
    resolved !== VRM_ROOT &&
    !resolved.startsWith(VRM_ROOT + path.sep)
  ) {
    throw new Error('path escapes vrm root')
  }
  // realpath catches symlink escapes. Requires the file to exist.
  const real = await realpath(resolved)
  if (real !== VRM_ROOT && !real.startsWith(VRM_ROOT + path.sep)) {
    throw new Error('symlink escapes vrm root')
  }
  return real
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export { devAssets }
