import { Hono } from 'hono'
import { getElevenLabsClient, STT_FILE_FORMAT, STT_MODEL_ID } from '../lib/stt'

const stt = new Hono()

/**
 * POST /api/stt
 *
 * Expects a multipart form with:
 *   - `audio`    : File/Blob — 16-bit PCM WAV (16 kHz, mono). The client
 *                  encodes the VAD-captured Float32 directly to this shape
 *                  so Scribe's `pcm_s16le_16` fast path applies.
 *   - `language` : optional BCP-47-ish hint ("en", "zh"). Empty / "auto"
 *                  lets Scribe detect.
 *
 * Returns `{ text, languageCode }`. Empty transcriptions ("") are passed
 * through — the turn controller decides whether to skip a turn.
 */
stt.post('/', async (c) => {
  if (!process.env.ELEVENLABS_API_KEY) {
    return c.json(
      { error: 'ELEVENLABS_API_KEY not configured on the server' },
      503,
    )
  }

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: 'Expected multipart/form-data body' }, 400)
  }

  const audio = form.get('audio')
  if (!(audio instanceof Blob) || audio.size === 0) {
    return c.json({ error: 'Missing or empty "audio" field' }, 400)
  }

  const languageRaw = form.get('language')
  const languageCode =
    typeof languageRaw === 'string' && languageRaw && languageRaw !== 'auto'
      ? languageRaw
      : undefined

  try {
    const client = getElevenLabsClient()
    const result = await client.speechToText.convert({
      modelId: STT_MODEL_ID,
      fileFormat: STT_FILE_FORMAT,
      file: audio,
      languageCode,
      // Scribe tags ambient events like "(instrumental music plays)"
      // inline with words by default. The LLM can't act on them (only
      // text), and they cluttered the user chat bubble. Disable until we
      // have a use for that context.
      tagAudioEvents: false,
    })

    // Scribe returns either a chunk response (single-channel, our case) or
    // a multichannel wrapper. We only send mono — grab `.text` defensively.
    const text =
      'text' in result && typeof result.text === 'string' ? result.text : ''
    const detected =
      'languageCode' in result && typeof result.languageCode === 'string'
        ? result.languageCode
        : null

    return c.json({ text, languageCode: detected })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[stt]', msg)
    return c.json({ error: msg }, 502)
  }
})

export { stt }
