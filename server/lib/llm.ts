import { createXai } from '@ai-sdk/xai'

let provider: ReturnType<typeof createXai> | null = null

// NOTICE:
// Default to xAI's eu-west-1 regional endpoint. Empirical measurement:
//   - api.x.ai/v1              → ~4s first-token on small prompts
//   - eu-west-1.api.x.ai/v1    → ~500ms first-token on small prompts
// OpenRouter (our previous relay) routed through US xAI and floored us
// at ~4s regardless of prompt size; direct + regional fixes that.
// Override via XAI_BASE_URL if the caller wants a different region.
// Regions reference: https://docs.x.ai/developers/regions
const DEFAULT_XAI_BASE_URL = 'https://eu-west-1.api.x.ai/v1'

/**
 * Lazily creates the xAI provider. Deferred so the server boots even
 * when XAI_API_KEY is missing (health route stays useful).
 */
function getProvider(): ReturnType<typeof createXai> {
  if (provider) return provider
  const apiKey = process.env.XAI_API_KEY
  if (!apiKey) {
    throw new Error('XAI_API_KEY not set — put it in .env (server-side only)')
  }
  provider = createXai({
    apiKey,
    baseURL: process.env.XAI_BASE_URL ?? DEFAULT_XAI_BASE_URL,
  })
  return provider
}

/**
 * The single model used for BOTH conversation and memory curation.
 *
 *   grok-4-1-fast-non-reasoning (direct via xAI, eu-west-1)
 *
 * Note on naming: xAI's native model id uses hyphens and a
 * `-non-reasoning` suffix. The previously-used OpenRouter slug
 * (`x-ai/grok-4.1-fast`) was OpenRouter's renaming, not xAI's own.
 *
 * Rationale:
 *  - Fast first-token latency via the regional endpoint
 *  - One API key + one billing line for everything LLM-related
 *  - Direct provider avoids the OpenRouter → US-xAI hop (~4s floor)
 */
export const CHAT_MODEL_ID = 'grok-4-1-fast-non-reasoning'

export function chatModel() {
  return getProvider()(CHAT_MODEL_ID)
}
