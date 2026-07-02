import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { v4 as uuidv4 } from 'uuid'

// Thin job-creator. yt-dlp download + MP3 conversion (which blew past Vercel's
// serverless wall on long tracks) now runs on the Railway worker. This route
// validates the URL, inserts a placeholder song row so it shows in the library
// immediately, and enqueues a 'process' job with source_type='soundcloud'. The
// worker downloads the track, uploads it to storage, backfills the song's
// original_url/filename, then runs the full pipeline.

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

export async function POST(request: NextRequest) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  const supabase = await createClient()
  const adminSupabase = createAdminClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: {
    soundcloudUrl: string
    trackTitle?: string
    artistName?: string
    geniusLyrics?: string
    muteType?: string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { soundcloudUrl, muteType = 'mute' } = body
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

  // ── Ensure profile + enforce plan limit (same as the upload path) ───────────
  const { data: profile0, error: selectErr } = await adminSupabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (selectErr && selectErr.code !== 'PGRST116') {
    console.error('[soundcloud] Profile SELECT error:', selectErr.code, selectErr.message)
    return NextResponse.json(
      { error: `Profile lookup failed: ${selectErr.message} (code: ${selectErr.code})` },
      { status: 500 }
    )
  }

  let profile = profile0
  if (!profile) {
    const { data: newProfile, error: insertErr } = await adminSupabase
      .from('profiles')
      .insert({ id: user.id, email: user.email ?? '', plan: 'free', songs_processed_this_month: 0 })
      .select()
      .single()
    if (insertErr || !newProfile) {
      console.error('[soundcloud] Profile INSERT failed:', insertErr?.message)
      return NextResponse.json(
        { error: `Could not create user profile: ${insertErr?.message ?? 'unknown'}` },
        { status: 500 }
      )
    }
    profile = newProfile
  }

  const FREE_LIMIT = 3
  if (profile.plan === 'free' && profile.songs_processed_this_month >= FREE_LIMIT) {
    return NextResponse.json(
      {
        error: 'Monthly limit reached',
        message: `You've used all ${FREE_LIMIT} free songs this month.`,
        upgrade: true,
      },
      { status: 429 }
    )
  }

  // ── Insert placeholder song + enqueue the download-and-process job ──────────
  const songId = uuidv4()
  const trackTitle = (body.trackTitle ?? '').trim()
  const artistName = (body.artistName ?? '').trim()
  // Best-effort display name until the worker fetches the real metadata and
  // backfills original_filename. Falls back to a generic label.
  const placeholderFilename =
    trackTitle || artistName ? buildFilename(trackTitle || 'SoundCloud track', artistName) : 'SoundCloud import.mp3'

  const { error: songErr } = await adminSupabase.from('songs').insert({
    id: songId,
    user_id: user.id,
    original_filename: placeholderFilename,
    status: 'processing',
    words_detected: [],
  })

  if (songErr) {
    console.error('[soundcloud] Song INSERT failed:', songErr.message)
    return NextResponse.json({ error: `Could not create song: ${songErr.message}` }, { status: 500 })
  }

  const { data: job, error: jobErr } = await adminSupabase
    .from('processing_jobs')
    .insert({
      user_id: user.id,
      song_id: songId,
      job_type: 'process',
      status: 'pending',
      source_type: 'soundcloud',
      source_url: url,
      original_filename: placeholderFilename,
      song_name: trackTitle || null,
      artist: artistName || null,
      mute_type: muteType,
      genius_lyrics: body.geniusLyrics ?? null,
    })
    .select('id')
    .single()

  if (jobErr || !job) {
    console.error('[soundcloud] Job INSERT failed:', jobErr?.message)
    await adminSupabase.from('songs').update({ status: 'failed' }).eq('id', songId)
    return NextResponse.json(
      { error: `Could not enqueue processing job: ${jobErr?.message ?? 'unknown'}` },
      { status: 500 }
    )
  }

  console.log(`[soundcloud] Enqueued job ${job.id} for song ${songId} (soundcloud: ${url})`)

  return NextResponse.json({ success: true, jobId: job.id, songId })
}
