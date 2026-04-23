import { tracer } from '../observability/tracer'

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
 *
 * Tracing:
 * - When `turnId` + `turnStartTs` are supplied, emits a three-stage
 *   timing breakdown — `llm.fetch-sent` (fetch resolved), then
 *   `llm.first-byte` (first chunk off the ReadableStream). The caller
 *   is expected to emit `llm.first-token` when the first DECODED delta
 *   is handed to the categorizer.
 */
export async function* streamChat(options: {
  messages: ChatMessage[]
  systemPrompt?: string
  signal?: AbortSignal
  /** Turn id — threaded into tracer events so the Metrics tab can group
   *  network-phase spans with the rest of the turn. */
  turnId?: string | null
  /** Wall-clock ms when the turn started. Used to compute `elapsedMs`
   *  for the fetch-sent / first-byte spans so they line up with the
   *  other turn-relative numbers on the Metrics tab. */
  turnStartTs?: number
}): AsyncGenerator<string, void, void> {
  const turnId = options.turnId ?? null
  const t0 = options.turnStartTs ?? Date.now()

  const res = await fetch('/api/chat', {
    method: 'POST',
    signal: options.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: options.messages,
      systemPrompt: options.systemPrompt,
    }),
  })

  // fetch() has returned — TCP + server-side fetch-to-OpenRouter handshake
  // is done. Body bytes haven't been read yet; the next measurement (first
  // chunk off the ReadableStream) isolates xAI prefill from that setup.
  tracer.emit({
    category: 'llm.fetch-sent',
    data: { elapsedMs: Date.now() - t0 },
    turnId,
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Chat ${res.status}: ${errText.slice(0, 300) || res.statusText}`)
  }
  if (!res.body) throw new Error('Chat: empty response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let firstByteSeen = false

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!firstByteSeen) {
        firstByteSeen = true
        // First Uint8Array arrived. The gap from fetch-sent → first-byte
        // is dominated by xAI prefill (+ OpenRouter relay). Useful when
        // reasoning about whether prefix caching is actually hitting.
        tracer.emit({
          category: 'llm.first-byte',
          data: { elapsedMs: Date.now() - t0 },
          turnId,
        })
      }
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
