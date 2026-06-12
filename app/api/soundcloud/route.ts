/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any, prefer-const */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { getYtDlpPath, getFfmpegDir, runYtDlp } from '@/lib/ytdlp'

export const maxDuration = 300

// ── helpers ───────────────────────────────────────────────────────────────────

function sanitize(s: string): string {
  return s.replace(/[/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim()
}

function buildFilename(title: string, artist: string): string {
  const cleanTitle = sanitize(title)
  const cleanArtist = sanitize(artist)
  if (cleanArtist && !cleanTitle.toLowerCase().includes(cleanArtist.toLowerCase())) {
    return `${cleanArtist} - ${cleanTitle}.mp3`
  }
  return `${cleanTitle}.mp3`
}

function isValidSoundCloudTrackUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    if (host !== 'soundcloud.com') return false
    const parts = parsed.pathname.split('/').filter(Boolean)
    return parts.length >= 2
  } catch {
    return false
  }
}

function isPlaylistUrl(url: string): boolean {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return parts.length >= 3 && parts[1] === 'sets'
  } catch {
    return false
  }
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

  if (!isValidSoundCloudTrackUrl(url)) {
    return NextResponse.json(
      { error: 'Not a valid SoundCloud URL. Paste a link like https://soundcloud.com/artist/track' },
      { status: 400 }
    )
  }
  if (isPlaylistUrl(url)) {
    return NextResponse.json(
      { error: 'Playlists are not supported. Please link to an individual track.' },
      { status: 400 }
    )
  }

  const songId = uuidv4()
  const tmpDir = os.tmpdir()
  const mp3Path = path.join(tmpDir, `sc_${songId}.mp3`)

  let ytdlpPath: string
  let ffmpegDir: string
  try {
    ytdlpPath = getYtDlpPath()
    ffmpegDir = getFfmpegDir()
    console.log(`[soundcloud] yt-dlp: ${ytdlpPath}, ffmpeg dir: ${ffmpegDir}`)
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[soundcloud] Binary setup failed:', msg)
    return NextResponse.json({ error: `Binary setup failed: ${msg}` }, { status: 500 })
  }

  try {
    // ── Step 1: Fetch metadata (no download) ─────────────────────────────────
    console.log(`[soundcloud] Step 1: fetching metadata for ${url}`)
    let trackTitle = 'Unknown Track'
    let artistName = ''
    try {
      const { stdout } = await runYtDlp(ytdlpPath, [
        '--no-playlist',
        '--ffmpeg-location', ffmpegDir,
        '--print', '%(uploader)s|||%(title)s',
        url,
      ])
      const line = stdout.trim().split('\n')[0] ?? ''
      const sep = line.indexOf('|||')
      if (sep !== -1) {
        artistName = line.slice(0, sep).trim()
        trackTitle = line.slice(sep + 3).trim()
      } else {
        trackTitle = line || trackTitle
      }
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[soundcloud] Step 1 FAILED:', msg)
      if (/private|unavailable|not exist|removed/i.test(msg)) {
        return NextResponse.json({ error: "This track is private or unavailable." }, { status: 422 })
      }
      return NextResponse.json({ error: `Step 1 failed — ${msg}` }, { status: 502 })
    }

    const originalFilename = buildFilename(trackTitle, artistName)
    console.log(`[soundcloud] Track: "${trackTitle}" by "${artistName}" → "${originalFilename}"`)

    // ── Step 2: Download + convert to MP3 ────────────────────────────────────
    console.log(`[soundcloud] Step 2: downloading and converting to MP3 → ${mp3Path}`)
    try {
      await runYtDlp(ytdlpPath, [
        '--no-playlist',
        '--ffmpeg-location', ffmpegDir,
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '-o', mp3Path,
        url,
      ])
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[soundcloud] Step 2 FAILED:', msg)
      return NextResponse.json({ error: `Step 2 failed — ${msg}` }, { status: 502 })
    }

    if (!fs.existsSync(mp3Path)) {
      console.error('[soundcloud] Step 2: mp3 file not found after yt-dlp:', mp3Path)
      return NextResponse.json({ error: 'Download completed but output file not found.' }, { status: 500 })
    }
    console.log(`[soundcloud] Step 2: MP3 ready (${fs.statSync(mp3Path).size} bytes)`)

    // ── Step 3: Upload to Supabase Storage ────────────────────────────────────
    const storagePath = `originals/${user.id}/${songId}.mp3`
    const mp3Buffer = fs.readFileSync(mp3Path)
    console.log(`[soundcloud] Step 3: uploading ${mp3Buffer.length} bytes → ${storagePath}`)

    const { error: uploadErr } = await adminSupabase.storage
      .from('audio')
      .upload(storagePath, mp3Buffer, { contentType: 'audio/mpeg', upsert: false })

    if (uploadErr) throw new Error(`Step 3 failed — storage: ${uploadErr.message}`)

    const { data: urlData } = adminSupabase.storage.from('audio').getPublicUrl(storagePath)

    console.log(`[soundcloud] Done. songId=${songId}`)
    return NextResponse.json({
      songId,
      originalUrl: urlData.publicUrl,
      originalFilename,
      trackTitle,
      artistName,
    })
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err ?? 'SoundCloud import failed')
    console.error(`[soundcloud] Unhandled error for url=${url}:`, err)
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path) } catch { /* non-fatal */ }
  }
}
