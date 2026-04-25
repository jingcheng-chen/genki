import 'dotenv/config'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { tts } from './routes/tts'
import { chat } from './routes/chat'
import { stt } from './routes/stt'
import { memory } from './routes/memory'
import { devAssets } from './routes/dev-assets'

const app = new Hono()

app.use('*', logger())

app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    time: new Date().toISOString(),
    hasXaiKey: Boolean(process.env.XAI_API_KEY),
    hasElevenLabsKey: Boolean(process.env.ELEVENLABS_API_KEY),
    hasFishAudioKey: Boolean(process.env.FISH_AUDIO_API_KEY),
    ttsProvider: (process.env.VITE_TTS_PROVIDER ?? process.env.TTS_PROVIDER ?? 'fish-audio').toLowerCase(),
  }),
)

app.route('/api/tts', tts)
app.route('/api/chat', chat)
app.route('/api/stt', stt)
app.route('/api/memory', memory)

// Dev-only asset manager API. The route file has no top-level side effects,
// so importing it in production is harmless; we just decline to mount it.
if (process.env.NODE_ENV !== 'production') {
  app.route('/api/dev/assets', devAssets)
}

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] Hono listening on http://localhost:${info.port}`)
})
