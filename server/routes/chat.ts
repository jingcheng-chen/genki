import { Hono } from 'hono'
import { streamText, type ModelMessage } from 'ai'
import { chatModel } from '../lib/llm'

const chat = new Hono()

interface ChatRequestBody {
  messages?: ModelMessage[]
  systemPrompt?: string
}

// NOTICE:
// Explicit prompt-cache breakpoint for the system message. OpenRouter's
// 2.8 AI-SDK provider reads `providerOptions.openrouter.cacheControl` off
// each ModelMessage and, for a system message, emits
//   { role: 'system', content: [{ type: 'text', text: '…', cache_control: {…} }] }
// on the wire. Anthropic-compatible endpoints honour this directly; xAI
// endpoints via OpenRouter accept the hint but may auto-cache regardless
// of breakpoint placement — placing a breakpoint at the end of the system
// message is still strictly better than nothing because it tells the
// relay "everything up to and including here is cacheable".
//
// Source: node_modules/@openrouter/ai-sdk-provider/dist/index.js:2899
// (convertToOpenRouterChatMessages → system branch attaches `cache_control`
// to the single text content part).
//
// The system prompt's block order (persona → protocol → rules →
// customInstructions → memoryBlock) is controlled client-side in
// `src/prompts/system.ts`. The memory/custom tail changes every turn,
// so the cache-effective prefix is everything up to (but not including)
// the memory tail. xAI's automatic prefix-matcher will pick the longest
// common span across turns, which is exactly the stable leading portion.
const SYSTEM_CACHE_CONTROL = { type: 'ephemeral' as const }

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
    // Attach an ephemeral cache-control breakpoint to the system message
    // only. The provider relays it as an Anthropic-format `cache_control`
    // field on the system text part; xAI routes this through as a hint to
    // their auto-cache layer (1024-token minimum). Non-system turns stay
    // unmarked — they're dynamic and shouldn't be cached.
    const messages: ModelMessage[] = body.systemPrompt
      ? [
          {
            role: 'system',
            content: body.systemPrompt,
            providerOptions: {
              openrouter: { cacheControl: SYSTEM_CACHE_CONTROL },
            },
          },
          ...body.messages,
        ]
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
