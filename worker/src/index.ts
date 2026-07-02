import express from 'express'
import { startPoller } from './poller'
import { fetchGeniusLyrics } from './services/genius'

const app = express()
app.use(express.json({ limit: '1mb' }))

// Health check for Railway + manual "is it alive" curls.
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'bleeep-worker', ts: new Date().toISOString() })
})
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'bleeep-worker' })
})

/**
 * POST /genius-lyrics  { artist, song } → { lyrics: string | null }
 *
 * Offloads the Genius lookup from Vercel, whose serverless IPs get HTTP 403'd
 * by Genius. Guarded by a shared secret in the `x-worker-secret` header so it
 * isn't an open scraping proxy.
 */
app.post('/genius-lyrics', async (req, res) => {
  const secret = process.env.WORKER_SECRET
  if (secret) {
    if (req.header('x-worker-secret') !== secret) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
  } else {
    console.warn('[genius-endpoint] WORKER_SECRET not set — endpoint is UNPROTECTED')
  }

  const artist = String(req.body?.artist ?? '').trim()
  const song = String(req.body?.song ?? '').trim()
  if (!artist || !song) {
    res.status(400).json({ error: 'artist and song are required' })
    return
  }

  try {
    const lyrics = await fetchGeniusLyrics(artist, song)
    res.json({ lyrics: lyrics ?? null })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Genius lookup failed'
    console.error('[genius-endpoint] failed:', message)
    res.status(500).json({ error: message })
  }
})

const port = Number(process.env.PORT) || 8080
app.listen(port, () => {
  console.log(`[worker] health server listening on :${port}`)
  startPoller()
})
