import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getYtDlpPath, getFfmpegDir, runYtDlp } from '@/lib/ytdlp'
import { fetchGeniusLyrics } from '@/lib/genius'

export const maxDuration = 60

const clean = (s: unknown) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200)

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { song?: string; artist?: string; album?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const song = clean(body.song)
  const artist = clean(body.artist)
  const album = clean(body.album)

  if (!song || !artist) {
    return NextResponse.json({ error: 'Song name and artist are required' }, { status: 400 })
  }

  // scsearch query: "{song} {artist}" (+ album when provided)
  const query = [song, artist, album].filter(Boolean).join(' ').slice(0, 200)

  try {
    const ytdlpPath = getYtDlpPath()
    const ffmpegDir = getFfmpegDir()

    // Run the SoundCloud search and the Genius lyrics lookup in parallel.
    const [ytResult, geniusLyrics] = await Promise.all([
      runYtDlp(ytdlpPath, [
        '--no-download',
        '--ffmpeg-location', ffmpegDir,
        '--print', '%(webpage_url)s|||%(uploader)s|||%(title)s',
        `scsearch1:${query}`,
      ]),
      fetchGeniusLyrics(artist, song),
    ])

    const line = ytResult.stdout.trim().split('\n')[0] ?? ''
    const [url, foundArtist, title] = line.split('|||').map((s) => s?.trim() ?? '')

    if (!url || !url.includes('soundcloud.com')) {
      return NextResponse.json(
        { error: 'No SoundCloud results found. Try a different search.' },
        { status: 404 }
      )
    }

    console.log(`[soundcloud-search] "${query}" → ${url} (genius lyrics: ${geniusLyrics ? 'yes' : 'no'})`)
    return NextResponse.json({ url, artist: foundArtist, title, geniusLyrics: geniusLyrics ?? null })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Search failed'
    console.error(`[soundcloud-search] FAILED query="${query}":`, message)
    // yt-dlp reports an empty search playlist as an error on some versions
    if (/no.*(entries|results)|playlist.*empty/i.test(message)) {
      return NextResponse.json(
        { error: 'No SoundCloud results found. Try a different search.' },
        { status: 404 }
      )
    }
    return NextResponse.json({ error: `Search failed — ${message}` }, { status: 502 })
  }
}
