import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getYtDlpPath, getFfmpegDir, runYtDlp } from '@/lib/ytdlp'

export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { query: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  // Strip control chars; scsearch treats the rest as a plain query string
  const query = (body.query ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200)
  if (!query) {
    return NextResponse.json({ error: 'Missing search query' }, { status: 400 })
  }

  try {
    const ytdlpPath = getYtDlpPath()
    const ffmpegDir = getFfmpegDir()

    const { stdout } = await runYtDlp(ytdlpPath, [
      '--no-download',
      '--ffmpeg-location', ffmpegDir,
      '--print', '%(webpage_url)s|||%(uploader)s|||%(title)s',
      `scsearch1:${query}`,
    ])

    const line = stdout.trim().split('\n')[0] ?? ''
    const [url, artist, title] = line.split('|||').map((s) => s?.trim() ?? '')

    if (!url || !url.includes('soundcloud.com')) {
      return NextResponse.json(
        { error: 'No SoundCloud results found. Try a different search.' },
        { status: 404 }
      )
    }

    console.log(`[soundcloud-search] "${query}" → ${url}`)
    return NextResponse.json({ url, artist, title })
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
