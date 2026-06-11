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

function sanitize(s: string): string {
  return s.replace(/[/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Build an "Artist - Title.mp3" filename so the existing parseFilename()
 * in lib/lrclib.ts can do LRCLIB lookups without any changes.
 */
function buildFilename(title: string, artist: string): string {
  const cleanTitle = sanitize(title)
  const cleanArtist = sanitize(artist)
  if (cleanArtist && !cleanTitle.toLowerCase().includes(cleanArtist.toLowerCase())) {
    return `${cleanArtist} - ${cleanTitle}.mp3`
  }
  return `${cleanTitle}.mp3`
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

  let body: { soundcloudUrl: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { soundcloudUrl } = body
  if (!soundcloudUrl) {
    return NextResponse.json({ error: 'Missing soundcloudUrl' }, { status: 400 })
  }

  const url = soundcloudUrl.trim()

  const songId = uuidv4()
  const tmpDir = os.tmpdir()
  const rawPath = path.join(tmpDir, `sc_raw_${songId}`)
  const mp3Path = path.join(tmpDir, `sc_out_${songId}.mp3`)

  try {
    const scdl = require('soundcloud-downloader').default

    // ── 1. Validate URL ──────────────────────────────────────────────────────
    if (!scdl.isValidUrl(url)) {
      return NextResponse.json(
        { error: 'Not a valid SoundCloud URL. Paste a link like https://soundcloud.com/artist/track' },
        { status: 400 }
      )
    }
    if (scdl.isPlaylistURL(url)) {
      return NextResponse.json(
        { error: 'Playlists are not supported. Please link to an individual track.' },
        { status: 400 }
      )
    }

    // ── 2. Fetch track metadata ──────────────────────────────────────────────
    console.log(`[soundcloud] Fetching info for: ${url}`)
    let info: any
    try {
      info = await scdl.getInfo(url)
    } catch (err: any) {
      const msg: string = err?.message ?? ''
      if (/private|not found|forbidden|404/i.test(msg) || err?.response?.status === 404) {
        return NextResponse.json(
          { error: "This track is private and can't be imported. Try uploading the MP3 directly instead." },
          { status: 422 }
        )
      }
      throw err
    }

    if (info?.sharing === 'private') {
      return NextResponse.json(
        { error: "This track is private and can't be imported. Try uploading the MP3 directly instead." },
        { status: 422 }
      )
    }

    const trackTitle: string = info.title ?? 'Unknown Track'
    const artistName: string = info.user?.username ?? info.user?.full_name ?? ''
    const originalFilename = buildFilename(trackTitle, artistName)
    console.log(`[soundcloud] "${trackTitle}" by "${artistName}" → filename: "${originalFilename}"`)

    // ── 3. Download audio stream ─────────────────────────────────────────────
    // Try MP3 first (direct download, no conversion needed); fall back to any format
    let audioStream: any
    try {
      audioStream = await scdl.downloadFormat(url, scdl.FORMATS.MP3)
      console.log('[soundcloud] Downloading as MP3')
    } catch {
      audioStream = await scdl.download(url)
      console.log('[soundcloud] Downloading as default format')
    }

    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(rawPath)
      audioStream.pipe(ws)
      ws.on('finish', resolve)
      ws.on('error', reject)
      audioStream.on('error', (err: Error) => reject(err))
    })
    console.log(`[soundcloud] Downloaded ${fs.statSync(rawPath).size} bytes`)

    // ── 4. Normalize to 192kbps MP3 via ffmpeg ───────────────────────────────
    const ffmpegPath = getFfmpegPath()
    const ffmpeg = require('fluent-ffmpeg')
    ffmpeg.setFfmpegPath(ffmpegPath)

    await new Promise<void>((resolve, reject) => {
      ffmpeg(rawPath)
        .audioCodec('libmp3lame')
        .audioBitrate('192k')
        .format('mp3')
        .output(mp3Path)
        .on('end', () => { console.log('[soundcloud] ffmpeg done'); resolve() })
        .on('error', (err: Error) => reject(new Error(`ffmpeg failed: ${err.message}`)))
        .run()
    })

    // ── 5. Upload to Supabase Storage ────────────────────────────────────────
    const storagePath = `originals/${user.id}/${songId}.mp3`
    const mp3Buffer = fs.readFileSync(mp3Path)
    console.log(`[soundcloud] Uploading ${mp3Buffer.length} bytes → ${storagePath}`)

    const { error: uploadErr } = await adminSupabase.storage
      .from('audio')
      .upload(storagePath, mp3Buffer, { contentType: 'audio/mpeg', upsert: false })

    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`)

    const { data: urlData } = adminSupabase.storage.from('audio').getPublicUrl(storagePath)

    console.log(`[soundcloud] Done. songId=${songId}`)
    return NextResponse.json({
      songId,
      originalUrl: urlData.publicUrl,
      originalFilename,
      trackTitle,
      artistName,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SoundCloud import failed'
    console.error(`[soundcloud] FAILED url=${url}:`, err)
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath) } catch { /* non-fatal */ }
    try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path) } catch { /* non-fatal */ }
  }
}
