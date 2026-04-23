import { Hono } from 'hono'
import { streamText, type ModelMessage } from 'ai'
import { chatModel } from '../lib/llm'

const chat = new Hono()

interface ChatRequestBody {
  messages?: ModelMessage[]
  systemPrompt?: string
}

/**
 * POST /api/chat
 *
 * Body: { messages: ModelMessage[], systemPrompt?: string }
 * Returns: text/event-stream containing plain text deltas (Vercel AI SDK
 *          text-stream protocol)
 *
 * The client consumes the body as a `ReadableStream<Uint8Array>`, decodes
 * chunks, and feeds them through the marker parser + response categorizer
 * pipeline in `src/adapters/llm.ts`.
 *
 * `c.req.raw.signal` propagates client aborts (Stop button, Phase 5 barge-in)
 * all the way to the upstream OpenRouter fetch — no wasted tokens on aborted
 * replies.
 */
chat.post('/', async (c) => {
  if (!process.env.OPENROUTER_API_KEY) {
    return c.json(
      { error: 'OPENROUTER_API_KEY not configured on the server' },
      503,
    )
  }

  let body: ChatRequestBody
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'Missing "messages" array' }, 400)
  }

  try {
    const messages: ModelMessage[] = body.systemPrompt
      ? [{ role: 'system', content: body.systemPrompt }, ...body.messages]
      : body.messages

    const result = streamText({
      model: chatModel(),
      messages,
      abortSignal: c.req.raw.signal,
      onError: ({ error }) => {
        // Vercel AI SDK 4.x surfaces upstream errors here instead of throwing
        // from streamText. Without this hook a failed OpenRouter call returns
        // an empty 200 body and the client sees silence.
        console.error('[chat:streamText]', error)
        if (error && typeof error === 'object') {
          for (const key of ['cause', 'responseBody', 'statusCode', 'url']) {
            const v = (error as Record<string, unknown>)[key]
            if (v !== undefined) console.error(`  ${key}:`, v)
          }
        }
      },
    })

    return result.toTextStreamResponse({
      headers: {
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[chat]', msg)
    return c.json({ error: msg }, 502)
  }
})

export { chat }
