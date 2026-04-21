import { Hono } from 'hono'
import {
  getElevenLabsClient,
  DEFAULT_VOICE_ID,
  TTS_MODEL_ID,
  TTS_OUTPUT_FORMAT,
} from '../lib/tts'

const tts = new Hono()

/**
 * POST /api/tts
 * Body: { text: string; voiceId?: string }
 * Returns: audio/mpeg stream (full MP3 bytes)
 *
 * We pipe ElevenLabs' ReadableStream straight to the client. The browser
 * buffers the full response before `decodeAudioData`, so we don't need
 * to chunk-decode — but streaming the response still trims ~50-150ms
 * off end-to-end latency vs. server-side buffering.
 */
tts.post('/', async (c) => {
  let body: { text?: string; voiceId?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const text = body.text?.trim()
  if (!text) return c.json({ error: 'Missing "text"' }, 400)

  const voiceId = body.voiceId ?? DEFAULT_VOICE_ID

  if (!process.env.ELEVENLABS_API_KEY) {
    return c.json(
      { error: 'ELEVENLABS_API_KEY not configured on the server' },
      503,
    )
  }

  try {
    const client = getElevenLabsClient()
    const stream = await client.textToSpeech.convert(voiceId, {
      text,
      modelId: TTS_MODEL_ID,
      outputFormat: TTS_OUTPUT_FORMAT,
    })

    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[tts]', msg)
    return c.json({ error: msg }, 502)
  }
})

export { tts }
