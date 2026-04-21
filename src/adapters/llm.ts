export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Streams an LLM reply from `/api/chat` as an AsyncIterable of text deltas.
 *
 * Use when:
 * - Driving the companion's turn: feed the AsyncIterable through the
 *   marker parser + response categorizer, which split it into speech (→TTS)
 *   and action markers (→expression queue).
 *
 * Aborts:
 * - `signal.abort()` cancels the fetch, which cancels the server's
 *   streamText(), which cancels the OpenRouter upstream fetch. Nothing
 *   continues to synthesize after the user barges in.
 *
 * Throws:
 * - On non-2xx, includes server error payload in the message.
 * - AbortError if the caller aborts (propagates verbatim).
 */
export async function* streamChat(options: {
  messages: ChatMessage[]
  systemPrompt?: string
  signal?: AbortSignal
}): AsyncGenerator<string, void, void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    signal: options.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: options.messages,
      systemPrompt: options.systemPrompt,
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Chat ${res.status}: ${errText.slice(0, 300) || res.statusText}`)
  }
  if (!res.body) throw new Error('Chat: empty response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      if (text.length > 0) yield text
    }
    // Flush any bytes the decoder is still holding (rare for UTF-8 text
    // streams but cheap insurance on mid-codepoint chunk boundaries).
    const tail = decoder.decode()
    if (tail.length > 0) yield tail
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}
