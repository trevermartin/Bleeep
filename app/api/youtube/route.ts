/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any, prefer-const */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { execSync } from 'child_process'
import { v4 as uuidv4 } from 'uuid'

export const maxDuration = 300

// ── helpers ───────────────────────────────────────────────────────────────────

function getFfmpegPath(): string {
  const ffmpegPath: string = require('ffmpeg-static')
  try { execSync(`chmod +x "${ffmpegPath}"`, { stdio: 'ignore' }) } catch { /* already executable */ }
  return ffmpegPath
}

/** Extract YouTube video ID from any common URL format. Returns null if invalid. */
function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '')
    if (host === 'youtu.be') {
      const id = parsed.pathname.slice(1).split('/')[0]
      return id || null
    }
    if (host === 'youtube.com') {
      const v = parsed.searchParams.get('v')
      if (v) return v
      const m = parsed.pathname.match(/^\/(?:shorts|embed|v)\/([A-Za-z0-9_-]{11})/)
      if (m) return m[1]
    }
    return null
  } catch {
    return null
  }
}

function sanitize(s: string): string {
  return s.replace(/[/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Derive an "Artist - Title.mp3" filename from a YouTube video title so that
 * the existing parseFilename() in lib/lrclib.ts can do LRCLIB lookups correctly.
 */
function buildFilename(videoTitle: string, channelName: string): string {
  const clean = videoTitle
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '') // strip (Official Video), [Lyrics], etc.
    .replace(/\s{2,}/g, ' ')
    .trim()

  if (clean.includes(' - ')) {
    return sanitize(clean) + '.mp3'
  }

  // Prepend channel name as artist (YouTube Music auto-generated channels end in " - Topic")
  const artist = sanitize(channelName.replace(/\s*-\s*Topic$/i, '').trim())
  return sanitize(artist ? `${artist} - ${clean}` : clean) + '.mp3'
}

// ── main handler ──────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  const supabase = await createClient()
  const adminSupabase = createAdminClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { youtubeUrl: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { youtubeUrl } = body
  if (!youtubeUrl) {
    return NextResponse.json({ error: 'Missing youtubeUrl' }, { status: 400 })
  }

  const videoId = extractVideoId(youtubeUrl.trim())
  if (!videoId) {
    return NextResponse.json(
      { error: 'Not a valid YouTube URL. Paste a link like https://youtube.com/watch?v=...' },
      { status: 400 }
    )
  }

  const songId = uuidv4()
  const tmpDir = os.tmpdir()
  const rawPath = path.join(tmpDir, `yt_raw_${songId}`)
  const mp3Path = path.join(tmpDir, `yt_out_${songId}.mp3`)

  try {
    const ytdl = require('@distube/ytdl-core')

    // ── 1. Fetch video metadata ──────────────────────────────────────────────
    console.log(`[youtube] Fetching info for videoId=${videoId}`)
    let info: any
    try {
      info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`)
    } catch (err: any) {
      const msg: string = err?.message ?? ''
      if (/unavailable|private|removed|doesn't exist/i.test(msg)) {
        return NextResponse.json(
          { error: "This video can't be imported (unavailable or private)" },
          { status: 422 }
        )
      }
      if (/age.?restricted|sign in/i.test(msg)) {
        return NextResponse.json(
          { error: "This video can't be imported (age-restricted)" },
          { status: 422 }
        )
      }
      throw err
    }

    const videoTitle: string = info.videoDetails.title
    const channelName: string = info.videoDetails.author?.name ?? ''
    const originalFilename = buildFilename(videoTitle, channelName)
    console.log(`[youtube] "${videoTitle}" → filename: "${originalFilename}"`)

    // ── 2. Download best audio-only stream ───────────────────────────────────
    const format = ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highestaudio' })
    console.log(`[youtube] Format: ${format.mimeType} @ ${format.audioBitrate}kbps`)

    const audioStream = ytdl.downloadFromInfo(info, { format })
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(rawPath)
      audioStream.pipe(ws)
      ws.on('finish', resolve)
      ws.on('error', reject)
      audioStream.on('error', (err: Error) => reject(err))
    })
    console.log(`[youtube] Downloaded ${fs.statSync(rawPath).size} bytes`)

    // ── 3. Convert to MP3 via ffmpeg ─────────────────────────────────────────
    const ffmpegPath = getFfmpegPath()
    const ffmpeg = require('fluent-ffmpeg')
    ffmpeg.setFfmpegPath(ffmpegPath)

    await new Promise<void>((resolve, reject) => {
      ffmpeg(rawPath)
        .audioCodec('libmp3lame')
        .audioBitrate('192k')
        .format('mp3')
        .output(mp3Path)
        .on('end', () => { console.log('[youtube] ffmpeg done'); resolve() })
        .on('error', (err: Error) => reject(new Error(`ffmpeg failed: ${err.message}`)))
        .run()
    })

    // ── 4. Upload to Supabase Storage ────────────────────────────────────────
    const storagePath = `originals/${user.id}/${songId}.mp3`
    const mp3Buffer = fs.readFileSync(mp3Path)
    console.log(`[youtube] Uploading ${mp3Buffer.length} bytes → ${storagePath}`)

    const { error: uploadErr } = await adminSupabase.storage
      .from('audio')
      .upload(storagePath, mp3Buffer, { contentType: 'audio/mpeg', upsert: false })

    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`)

    const { data: urlData } = adminSupabase.storage.from('audio').getPublicUrl(storagePath)

    console.log(`[youtube] Done. songId=${songId}`)
    return NextResponse.json({
      songId,
      originalUrl: urlData.publicUrl,
      originalFilename,
      videoTitle,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'YouTube import failed'
    console.error(`[youtube] FAILED videoId=${videoId}:`, err)
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath) } catch { /* non-fatal */ }
    try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path) } catch { /* non-fatal */ }
  }
}
