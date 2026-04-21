import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider'

let provider: OpenRouterProvider | null = null

/**
 * Lazily creates the OpenRouter provider. Deferred so the server boots even
 * when OPENROUTER_API_KEY is missing (health route stays useful).
 */
function getProvider(): OpenRouterProvider {
  if (provider) return provider
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set — put it in .env (server-side only)')
  }
  provider = createOpenRouter({ apiKey })
  return provider
}

/**
 * The single model used for BOTH conversation and memory curation.
 *
 *   x-ai/grok-4.1-fast (via OpenRouter)
 *
 * Note on naming: OpenRouter publishes the model as `x-ai/grok-4.1-fast`
 * (hyphenated prefix, no `-non-reasoning` suffix). The non-reasoning mode
 * is the DEFAULT — reasoning is a per-request opt-in via provider options.
 * We don't opt in, so <think>…</think> shouldn't appear; the response
 * categorizer is kept as defence-in-depth.
 *
 * Rationale (per PLAN.md §3):
 *  - Fast first-token latency
 *  - One API key + one billing line for everything LLM-related
 *  - Rerouteable via OpenRouter if xAI has an outage — just change the model id
 */
export const CHAT_MODEL_ID = 'x-ai/grok-4.1-fast'

export function chatModel() {
  return getProvider()(CHAT_MODEL_ID)
}
