import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'

/**
 * Prefix-caching wire contract test — pinned after the Pass-3 latency work.
 *
 * The chat route attaches `providerOptions.openrouter.cacheControl =
 * { type: 'ephemeral' }` to the system message. The OpenRouter AI-SDK
 * provider is contractually responsible for translating that into a
 * per-message `cache_control` field on the system content part that gets
 * POSTed to `https://openrouter.ai/api/v1/chat/completions`. xAI (through
 * OpenRouter's Anthropic-cache-hint passthrough) uses this as the
 * breakpoint for its automatic prefix matcher.
 *
 * This test intercepts the upstream fetch and asserts:
 *   1. The wire body has exactly one system message.
 *   2. That system message's content[0] carries
 *      `cache_control: { type: 'ephemeral' }`.
 *   3. User/assistant messages DO NOT carry cache_control (they're dynamic
 *      and shouldn't be marked cacheable).
 *
 * Without this test, a future SDK upgrade that renames the provider option
 * (e.g. `cacheControl` → `promptCaching`) would silently regress TTFT on
 * turns 2+ back to the un-cached 3-4s baseline and we'd have no CI signal.
 */

async function readBodyJson(request: Request): Promise<unknown> {
  // Hono wraps the body as a ReadableStream; Node-18+ `.json()` works fine.
  return request.json()
}

let capturedBody: Record<string, unknown> | null = null

function installFakeOpenRouterFetch(ssePayload: string) {
  // NOTICE:
  // The OpenRouter provider streams an `text/event-stream` response shaped
  // like OpenAI chat.completions.chunk lines. We feed a single `[DONE]`
  // so the provider's SSE decoder exits cleanly without producing any
  // content — enough to satisfy the streamText call, since we only care
  // about the OUTBOUND request body.
  const fakeFetch: typeof fetch = async (input, init) => {
    const req =
      input instanceof Request ? input : new Request(String(input), init)
    capturedBody = (await readBodyJson(req)) as Record<string, unknown>

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(ssePayload))
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  return fakeFetch
}

async function drainTextStream(res: Response): Promise<void> {
  if (!res.body) return
  const reader = res.body.getReader()
  try {
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
}

describe('POST /api/chat — prefix caching wire contract', () => {
  beforeEach(() => {
    capturedBody = null
    process.env.OPENROUTER_API_KEY = 'test-key'
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
    delete process.env.OPENROUTER_API_KEY
  })

  /**
   * @example
   *   client POST { systemPrompt: 'You are Mika…', messages: [user] }
   *   wire body: messages[0] = {
   *     role: 'system',
   *     content: [{ type: 'text', text: 'You are Mika…',
   *                 cache_control: { type: 'ephemeral' } }]
   *   }
   */
  it('attaches cache_control:ephemeral to the system message content part', async () => {
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider')
    const fakeFetch = installFakeOpenRouterFetch(
      'data: [DONE]\n\n',
    )
    const provider = createOpenRouter({ apiKey: 'test-key', fetch: fakeFetch })

    // Inject the stubbed provider into the route module. We re-import the
    // route fresh and monkey-patch `chatModel()` on the server/lib/llm
    // module — simpler than factoring a DI seam for a single test.
    vi.doMock('../../lib/llm', () => ({
      CHAT_MODEL_ID: 'x-ai/grok-4.1-fast',
      chatModel: () => provider('x-ai/grok-4.1-fast'),
    }))

    const { chat } = await import('../chat')
    const app = new Hono().route('/api/chat', chat)

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemPrompt: 'You are Mika. You like rock climbing.',
        messages: [{ role: 'user', content: 'Hi there' }],
      }),
    })
    expect(res.status).toBe(200)
    await drainTextStream(res)

    expect(capturedBody).not.toBeNull()
    const body = capturedBody as {
      messages: Array<{
        role: string
        content: unknown
      }>
    }
    expect(body.messages.length).toBe(2)

    const system = body.messages[0]
    expect(system.role).toBe('system')
    // The provider wraps system content in an array of text parts so it
    // can attach `cache_control` to the final part.
    expect(Array.isArray(system.content)).toBe(true)
    const parts = system.content as Array<{
      type: string
      text: string
      cache_control?: { type: string }
    }>
    expect(parts.length).toBe(1)
    expect(parts[0].type).toBe('text')
    expect(parts[0].text).toBe('You are Mika. You like rock climbing.')
    expect(parts[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  /**
   * @example
   *   user message on the wire:
   *     { role: 'user', content: 'Hi there' }  (plain string — uncached)
   */
  it('does not attach cache_control to user messages', async () => {
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider')
    const fakeFetch = installFakeOpenRouterFetch('data: [DONE]\n\n')
    const provider = createOpenRouter({ apiKey: 'test-key', fetch: fakeFetch })

    vi.doMock('../../lib/llm', () => ({
      CHAT_MODEL_ID: 'x-ai/grok-4.1-fast',
      chatModel: () => provider('x-ai/grok-4.1-fast'),
    }))

    const { chat } = await import('../chat')
    const app = new Hono().route('/api/chat', chat)

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemPrompt: 'sys',
        messages: [
          { role: 'user', content: 'A' },
          { role: 'assistant', content: 'B' },
          { role: 'user', content: 'C' },
        ],
      }),
    })
    expect(res.status).toBe(200)
    await drainTextStream(res)

    const body = capturedBody as {
      messages: Array<{ role: string; content: unknown }>
    }
    const nonSystem = body.messages.filter((m) => m.role !== 'system')
    for (const m of nonSystem) {
      // Either string content (uncached) OR an array where no part carries
      // cache_control. Assert both possibilities generically.
      if (typeof m.content === 'string') continue
      if (!Array.isArray(m.content)) continue
      for (const part of m.content as Array<Record<string, unknown>>) {
        expect(part.cache_control).toBeUndefined()
      }
    }
  })

  /**
   * @example
   *   request with no systemPrompt → wire has no system message and
   *   certainly no cache_control anywhere.
   */
  it('omits the system message entirely when no systemPrompt is provided', async () => {
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider')
    const fakeFetch = installFakeOpenRouterFetch('data: [DONE]\n\n')
    const provider = createOpenRouter({ apiKey: 'test-key', fetch: fakeFetch })

    vi.doMock('../../lib/llm', () => ({
      CHAT_MODEL_ID: 'x-ai/grok-4.1-fast',
      chatModel: () => provider('x-ai/grok-4.1-fast'),
    }))

    const { chat } = await import('../chat')
    const app = new Hono().route('/api/chat', chat)

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    })
    expect(res.status).toBe(200)
    await drainTextStream(res)

    const body = capturedBody as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.messages.find((m) => m.role === 'system')).toBeUndefined()
  })
})
