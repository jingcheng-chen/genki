import 'dotenv/config'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { tts } from './routes/tts'
import { chat } from './routes/chat'
import { stt } from './routes/stt'
import { memory } from './routes/memory'

const app = new Hono()

app.use('*', logger())

app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    time: new Date().toISOString(),
    hasXaiKey: Boolean(process.env.XAI_API_KEY),
    hasElevenLabsKey: Boolean(process.env.ELEVENLABS_API_KEY),
  }),
)

app.route('/api/tts', tts)
app.route('/api/chat', chat)
app.route('/api/stt', stt)
app.route('/api/memory', memory)

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] Hono listening on http://localhost:${info.port}`)
})
