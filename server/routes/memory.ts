import { Hono } from 'hono'
import { generateObject } from 'ai'
import { chatModel } from '../lib/llm'
import {
  buildCompactorPrompt,
  buildExtractorPrompt,
  CompactorResultSchema,
  ExtractorResultSchema,
  type ExtractorResult,
} from '../lib/memory'

const memory = new Hono()

/**
 * POST /api/memory/extract
 *
 * Body:
 *   {
 *     userTurn: string,
 *     assistantTurn: string,
 *     retrievedFacts: Array<{ id: string; content: string; category: string }>
 *   }
 *
 * Returns the ExtractorResult shape — new/reinforced/outdated fact lists.
 *
 * Implementation: the AI SDK's `generateObject` feeds our Zod schema
 * straight to the provider's structured output path so the model is
 * forced to emit conformant JSON; we never have to hand-parse markdown
 * or tolerate LLM prose.
 */
memory.post('/extract', async (c) => {
  if (!process.env.XAI_API_KEY) {
    return c.json(
      { error: 'XAI_API_KEY not configured on the server' },
      503,
    )
  }

  let body: {
    userTurn?: string
    assistantTurn?: string
    retrievedFacts?: Array<{ id: string; content: string; category: string }>
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const userTurn = typeof body.userTurn === 'string' ? body.userTurn : ''
  const assistantTurn =
    typeof body.assistantTurn === 'string' ? body.assistantTurn : ''
  const retrievedFacts = Array.isArray(body.retrievedFacts)
    ? body.retrievedFacts
        .filter(
          (f): f is { id: string; content: string; category: string } =>
            !!f &&
            typeof f.id === 'string' &&
            typeof f.content === 'string' &&
            typeof f.category === 'string',
        )
        .slice(0, 64) // defensive cap; retriever tops out at ~K+small anyway
    : []

  if (!userTurn.trim() && !assistantTurn.trim()) {
    // Empty turn → no signal. Return an empty result instead of an LLM
    // call so we don't waste tokens on pathological requests.
    const empty: ExtractorResult = {
      new_facts: [],
      reinforced_fact_ids: [],
      outdated_fact_ids: [],
    }
    return c.json(empty)
  }

  try {
    const prompt = buildExtractorPrompt({
      userTurn,
      assistantTurn,
      retrievedFacts,
    })

    const { object } = await generateObject({
      model: chatModel(),
      schema: ExtractorResultSchema,
      prompt,
      abortSignal: c.req.raw.signal,
    })

    return c.json(object)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[memory:extract]', msg)
    return c.json({ error: msg }, 502)
  }
})

/**
 * POST /api/memory/compact
 *
 * Body: { content: string, targetWords: number }
 * Returns: { content: string }
 *
 * Per-fact compaction. Called by the client compactor for each fact
 * below the retention threshold; it bumps compressionLevel and stores
 * the rewritten content.
 */
memory.post('/compact', async (c) => {
  if (!process.env.XAI_API_KEY) {
    return c.json(
      { error: 'XAI_API_KEY not configured on the server' },
      503,
    )
  }

  let body: { content?: unknown; targetWords?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const content =
    typeof body.content === 'string' ? body.content.trim() : ''
  const targetWords =
    typeof body.targetWords === 'number' && Number.isFinite(body.targetWords)
      ? Math.max(1, Math.min(200, Math.floor(body.targetWords)))
      : 40

  if (!content) {
    return c.json({ error: 'Missing "content"' }, 400)
  }

  try {
    const prompt = buildCompactorPrompt({ content, targetWords })

    const { object } = await generateObject({
      model: chatModel(),
      schema: CompactorResultSchema,
      prompt,
      abortSignal: c.req.raw.signal,
    })

    return c.json(object)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[memory:compact]', msg)
    return c.json({ error: msg }, 502)
  }
})

export { memory }
