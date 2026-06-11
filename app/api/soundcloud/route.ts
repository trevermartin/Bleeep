/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any, prefer-const */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import axios from 'axios'
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

const SC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

/**
 * Extract a SoundCloud client_id by scraping the homepage for JS bundles.
 * Falls back to SOUNDCLOUD_CLIENT_ID env var if set.
 */
async function getClientId(): Promise<string> {
  if (process.env.SOUNDCLOUD_CLIENT_ID) {
    console.log('[soundcloud] Using SOUNDCLOUD_CLIENT_ID from env')
    return process.env.SOUNDCLOUD_CLIENT_ID
  }

  console.log('[soundcloud] Fetching homepage to extract client_id...')
  const homeRes = await axios.get('https://soundcloud.com', {
    headers: SC_HEADERS,
    timeout: 12000,
  })
  const html: string = homeRes.data

  // Collect all script bundle URLs from the page
  const scriptUrls: string[] = []
  const re = /<script[^>]+src="(https?:\/\/[^"]+\.js)"/g
  let m
  while ((m = re.exec(html)) !== null) scriptUrls.push(m[1])
  console.log(`[soundcloud] Found ${scriptUrls.length} script(s) to scan for client_id`)

  // Try multiple regex patterns against each bundle (check last scripts first — app bundle is last)
  const patterns = [
    /client_id:"([a-zA-Z0-9]{32})"/,
    /client_id=([a-zA-Z0-9]{32})[^a-zA-Z0-9]/,
    /"client_id":"([a-zA-Z0-9]{32})"/,
  ]

  for (const scriptUrl of [...scriptUrls].reverse()) {
    try {
      const scriptRes = await axios.get(scriptUrl, { headers: SC_HEADERS, timeout: 10000 })
      for (const pat of patterns) {
        const match = (scriptRes.data as string).match(pat)
        if (match) {
          console.log(`[soundcloud] Extracted client_id via pattern ${pat} from ${scriptUrl}`)
          return match[1]
        }
      }
    } catch (e: any) {
      console.warn(`[soundcloud] Script fetch failed: ${scriptUrl} — ${e?.message}`)
    }
  }

  throw new Error(
    `Could not extract SoundCloud client_id from ${scriptUrls.length} script(s). ` +
    `Set SOUNDCLOUD_CLIENT_ID env var to bypass scraping.`
  )
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
  const mp3Path = path.join(tmpDir, `sc_out_${songId}.mp3`)

  try {
    // ── Step 1: Get client_id ─────────────────────────────────────────────────
    let clientId: string
    try {
      clientId = await getClientId()
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[soundcloud] Step 1 FAILED (client_id):', msg)
      return NextResponse.json({ error: `Step 1 failed — ${msg}` }, { status: 502 })
    }

    // ── Step 2: Resolve track info ────────────────────────────────────────────
    console.log(`[soundcloud] Step 2: resolving track info for ${url}`)
    let trackInfo: any
    try {
      const res = await axios.get('https://api-v2.soundcloud.com/resolve', {
        params: { url, client_id: clientId },
        headers: SC_HEADERS,
        timeout: 15000,
      })
      trackInfo = res.data
    } catch (err: any) {
      const status = err?.response?.status
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[soundcloud] Step 2 FAILED (resolve, HTTP ${status}):`, msg)
      if (status === 404) {
        return NextResponse.json({ error: 'Track not found — check the URL.' }, { status: 422 })
      }
      if (status === 401 || status === 403) {
        return NextResponse.json({ error: `Track is private or client_id was rejected (HTTP ${status}). Set SOUNDCLOUD_CLIENT_ID env var if this keeps happening.` }, { status: 422 })
      }
      return NextResponse.json({ error: `Step 2 failed — ${msg}` }, { status: 502 })
    }

    if (trackInfo?.sharing === 'private') {
      return NextResponse.json({ error: "This track is private and can't be imported." }, { status: 422 })
    }
    if (trackInfo?.kind !== 'track') {
      return NextResponse.json({ error: `URL resolved to a ${trackInfo?.kind ?? 'non-track'}, not a track.` }, { status: 422 })
    }

    const trackTitle: string = trackInfo.title ?? 'Unknown Track'
    const artistName: string = trackInfo.user?.username ?? trackInfo.user?.full_name ?? ''
    const originalFilename = buildFilename(trackTitle, artistName)
    console.log(`[soundcloud] Track: "${trackTitle}" by "${artistName}" → "${originalFilename}"`)

    // ── Step 3: Find HLS transcoding ──────────────────────────────────────────
    const transcodings: any[] = trackInfo?.media?.transcodings ?? []
    const trackAuth: string = trackInfo?.track_authorization ?? ''
    console.log(`[soundcloud] Step 3: found ${transcodings.length} transcoding(s):`, transcodings.map((t: any) => `${t?.format?.protocol}/${t?.format?.mime_type}`))
    console.log(`[soundcloud] Step 3: track_authorization present: ${!!trackAuth}`)
    // Prefer audio/mpeg HLS (MP3); fall back to any HLS
    const hls =
      transcodings.find((t: any) => t?.format?.protocol === 'hls' && t?.format?.mime_type?.includes('mpeg')) ??
      transcodings.find((t: any) => t?.format?.protocol === 'hls')
    if (!hls) {
      return NextResponse.json({ error: `No HLS stream available. Formats: ${transcodings.map((t: any) => t?.format?.protocol).join(', ')}` }, { status: 422 })
    }
    console.log(`[soundcloud] Step 3: using transcoding ${hls.format?.protocol}/${hls.format?.mime_type}`)

    // ── Step 4: Get m3u8 URL ──────────────────────────────────────────────────
    // SoundCloud requires both client_id and track_authorization on this endpoint.
    const step4Params: Record<string, string> = { client_id: clientId }
    if (trackAuth) step4Params.track_authorization = trackAuth
    const step4Url = `${hls.url}?${new URLSearchParams(step4Params).toString()}`
    console.log(`[soundcloud] Step 4: fetching m3u8 URL from ${step4Url}`)
    let m3u8Url: string
    try {
      const streamRes = await axios.get(hls.url, {
        params: step4Params,
        headers: {
          ...SC_HEADERS,
          Authorization: `OAuth ${clientId}`,
        },
        timeout: 10000,
      })
      m3u8Url = streamRes.data?.url
      if (!m3u8Url) throw new Error(`Unexpected response shape: ${JSON.stringify(streamRes.data).slice(0, 200)}`)
      console.log('[soundcloud] Step 4: got m3u8 URL:', m3u8Url.slice(0, 80) + '...')
    } catch (err: any) {
      const status = err?.response?.status
      const body = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : ''
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[soundcloud] Step 4 FAILED (HTTP ${status}): ${msg} — body: ${body}`)
      return NextResponse.json({ error: `Step 4 failed (HTTP ${status ?? 'no response'}) — ${msg}` }, { status: 502 })
    }

    // ── Step 5: ffmpeg HLS → MP3 ──────────────────────────────────────────────
    console.log('[soundcloud] Step 5: ffmpeg HLS download + MP3 conversion...')
    const ffmpegPath = getFfmpegPath()
    const ffmpeg = require('fluent-ffmpeg')
    ffmpeg.setFfmpegPath(ffmpegPath)

    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(m3u8Url)
          .inputOptions(['-allowed_extensions', 'ALL'])
          .audioCodec('libmp3lame')
          .audioBitrate('192k')
          .format('mp3')
          .output(mp3Path)
          .on('end', () => { console.log('[soundcloud] Step 5: ffmpeg done'); resolve() })
          .on('error', (err: Error) => reject(new Error(`Step 5 failed — ffmpeg: ${err.message}`)))
          .run()
      })
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[soundcloud] Step 5 FAILED (ffmpeg):', msg)
      return NextResponse.json({ error: msg }, { status: 500 })
    }

    // ── Step 6: Upload to Supabase Storage ────────────────────────────────────
    const storagePath = `originals/${user.id}/${songId}.mp3`
    const mp3Buffer = fs.readFileSync(mp3Path)
    console.log(`[soundcloud] Step 6: uploading ${mp3Buffer.length} bytes → ${storagePath}`)

    const { error: uploadErr } = await adminSupabase.storage
      .from('audio')
      .upload(storagePath, mp3Buffer, { contentType: 'audio/mpeg', upsert: false })

    if (uploadErr) throw new Error(`Step 6 failed — storage: ${uploadErr.message}`)

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
