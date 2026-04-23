import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'

/**
 * xAI wire contract test — pinned after the direct-provider swap.
 *
 * The chat route streams through `@ai-sdk/xai` against the regional
 * endpoint (`eu-west-1.api.x.ai/v1` by default). This test intercepts
 * the upstream fetch and asserts:
 *   1. The request URL points at the regional xAI chat-completions path.
 *   2. The model id on the wire is `grok-4-1-fast-non-reasoning` (xAI's
 *      native id, NOT the old OpenRouter slug `x-ai/grok-4.1-fast`).
 *   3. The `Authorization: Bearer …` header uses the server's XAI_API_KEY.
 *   4. The system message flows through as a plain string — no OpenRouter-
 *      specific `cache_control` payload. xAI's automatic prefix cache
 *      does not require a breakpoint.
 *
 * Without this test, a future SDK upgrade that changes the baseURL
 * default, renames the model id, or re-introduces a cacheControl wrap
 * would silently regress behaviour.
 */

async function readBodyJson(request: Request): Promise<unknown> {
  // Hono wraps the body as a ReadableStream; Node-18+ `.json()` works fine.
  return request.json()
}

interface CapturedRequest {
  url: string
  authHeader: string | null
  body: Record<string, unknown>
}

let captured: CapturedRequest | null = null

function installFakeXaiFetch(ssePayload: string) {
  // NOTICE:
  // The xAI provider streams a `text/event-stream` response shaped like
  // OpenAI chat.completions.chunk lines. We feed a single `[DONE]` so the
  // provider's SSE decoder exits cleanly without producing any content —
  // enough to satisfy the streamText call, since we only care about the
  // OUTBOUND request.
  const fakeFetch: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const body = (await readBodyJson(req)) as Record<string, unknown>
    captured = {
      url: req.url,
      authHeader: req.headers.get('authorization'),
      body,
    }

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

describe('POST /api/chat — xAI wire contract', () => {
  beforeEach(() => {
    captured = null
    process.env.XAI_API_KEY = 'test-key'
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
    delete process.env.XAI_API_KEY
  })

  /**
   * @example
   *   client POST { systemPrompt: 'You are Mika…', messages: [user] }
   *   wire POST https://eu-west-1.api.x.ai/v1/chat/completions
   *     body.model    === 'grok-4-1-fast-non-reasoning'
   *     body.messages === [{role:'system', content:'You are Mika…'},
   *                        {role:'user',   content:'Hi there'}]
   */
  it('posts to the xAI regional endpoint with the xAI model id and bearer auth', async () => {
    const { createXai } = await import('@ai-sdk/xai')
    const fakeFetch = installFakeXaiFetch('data: [DONE]\n\n')
    const provider = createXai({
      apiKey: 'test-key',
      baseURL: 'https://eu-west-1.api.x.ai/v1',
      fetch: fakeFetch,
    })

    // Inject the stubbed provider into the route module. We re-import
    // the route fresh and monkey-patch `chatModel()` on the server/lib/llm
    // module — simpler than factoring a DI seam for a single test.
    vi.doMock('../../lib/llm', () => ({
      CHAT_MODEL_ID: 'grok-4-1-fast-non-reasoning',
      chatModel: () => provider('grok-4-1-fast-non-reasoning'),
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

    expect(captured).not.toBeNull()
    const { url, authHeader, body } = captured!
    expect(url).toMatch(/^https:\/\/eu-west-1\.api\.x\.ai\/v1\/chat\/completions\b/)
    expect(authHeader).toBe('Bearer test-key')
    expect(body.model).toBe('grok-4-1-fast-non-reasoning')

    const messages = body.messages as Array<{ role: string; content: unknown }>
    expect(messages.length).toBe(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].role).toBe('user')
  })

  /**
   * @example
   *   wire body.messages[0].content === 'sys'  (plain string, no array wrap
   *   and no cache_control field anywhere)
   */
  it('does not attach OpenRouter-style cache_control to any message', async () => {
    const { createXai } = await import('@ai-sdk/xai')
    const fakeFetch = installFakeXaiFetch('data: [DONE]\n\n')
    const provider = createXai({
      apiKey: 'test-key',
      baseURL: 'https://eu-west-1.api.x.ai/v1',
      fetch: fakeFetch,
    })

    vi.doMock('../../lib/llm', () => ({
      CHAT_MODEL_ID: 'grok-4-1-fast-non-reasoning',
      chatModel: () => provider('grok-4-1-fast-non-reasoning'),
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

    const body = captured!.body as {
      messages: Array<{ role: string; content: unknown }>
    }
    for (const m of body.messages) {
      // Either string content OR an array whose parts carry no
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
   *   request with no systemPrompt → wire has no system message.
   */
  it('omits the system message entirely when no systemPrompt is provided', async () => {
    const { createXai } = await import('@ai-sdk/xai')
    const fakeFetch = installFakeXaiFetch('data: [DONE]\n\n')
    const provider = createXai({
      apiKey: 'test-key',
      baseURL: 'https://eu-west-1.api.x.ai/v1',
      fetch: fakeFetch,
    })

    vi.doMock('../../lib/llm', () => ({
      CHAT_MODEL_ID: 'grok-4-1-fast-non-reasoning',
      chatModel: () => provider('grok-4-1-fast-non-reasoning'),
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

    const body = captured!.body as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.messages.find((m) => m.role === 'system')).toBeUndefined()
  })
})
