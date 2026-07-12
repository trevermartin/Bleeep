import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

const ALLOWED_MUTE_TYPES = new Set(['mute', 'warp', 'bleep'])

/**
 * Anti-SSRF: the worker fetches `originalUrl` (and hands it to MVSEP), so it
 * MUST be one of our own public storage objects owned by this user — never an
 * arbitrary URL the caller supplies (which could point at cloud metadata
 * endpoints, internal services, or someone else's file). We require the exact
 * public-object prefix for THIS user's originals folder.
 */
function isOwnStorageUrl(url: string, userId: string): boolean {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return false
  const expectedPrefix = `${base.replace(/\/$/, '')}/storage/v1/object/public/audio/originals/${userId}/`
  try {
    // Reject anything that isn't a plain https URL under our prefix.
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return url.startsWith(expectedPrefix)
  } catch {
    return false
  }
}

// Thin job-creator. All heavy audio processing (MVSEP isolation, AssemblyAI
// transcription, Genius lookup, FFmpeg render) now runs on the persistent
// Railway worker, which can't be killed at Vercel's 60s serverless wall. This
// route only authenticates, enforces the plan limit, inserts the song row, and
// enqueues a processing_jobs row the worker claims and runs. It returns a jobId
// the browser subscribes to via Supabase Realtime.

export async function POST(request: NextRequest) {
  // Guard: catch missing env vars early with a clear message
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[process] FATAL: SUPABASE_SERVICE_ROLE_KEY is not set')
    return NextResponse.json(
      { error: 'Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY' },
      { status: 500 }
    )
  }

  const supabase = await createClient()
  const adminSupabase = createAdminClient()

  // 1. Auth check
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Fetch profile — auto-create if missing (handles accounts that
  //    signed up before the on_auth_user_created trigger was deployed)
  const { data: profile0, error: selectErr } = await adminSupabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (selectErr && selectErr.code !== 'PGRST116') {
    console.error('[process] Profile SELECT error:', selectErr.code, selectErr.message, selectErr.details)
    return NextResponse.json({ error: 'Could not load your account. Please try again.' }, { status: 500 })
  }

  let profile = profile0

  if (!profile) {
    console.log(`[process] No profile for user ${user.id} (${user.email}), auto-creating...`)
    const { data: newProfile, error: insertErr } = await adminSupabase
      .from('profiles')
      .insert({ id: user.id, email: user.email ?? '', plan: 'free', songs_processed_this_month: 0 })
      .select()
      .single()

    if (insertErr || !newProfile) {
      console.error('[process] Profile INSERT failed:', insertErr?.code, insertErr?.message, insertErr?.details, insertErr?.hint)
      return NextResponse.json({ error: 'Could not initialize your account. Please try again.' }, { status: 500 })
    }
    console.log(`[process] Profile auto-created for user ${user.id}`)
    profile = newProfile
  }

  // 3. Check plan / usage limits
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

  // 4. Parse JSON body — the file was already uploaded to Supabase by the browser
  let body: {
    songId: string
    originalUrl: string
    originalFilename: string
    muteType: string
    manualLyrics?: string
    geniusLyrics?: string
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { songId, originalUrl, originalFilename, muteType = 'mute' } = body

  if (!songId || !originalUrl || !originalFilename) {
    return NextResponse.json(
      { error: 'Missing required fields: songId, originalUrl, originalFilename' },
      { status: 400 }
    )
  }

  // Validate songId is a UUID (it becomes the songs PK + storage key segment).
  if (typeof songId !== 'string' || !/^[0-9a-f-]{36}$/i.test(songId)) {
    return NextResponse.json({ error: 'Invalid songId' }, { status: 400 })
  }

  // Anti-SSRF: originalUrl must be THIS user's own storage object, not an
  // arbitrary URL the worker would blindly fetch.
  if (typeof originalUrl !== 'string' || !isOwnStorageUrl(originalUrl, user.id)) {
    return NextResponse.json({ error: 'Invalid audio URL' }, { status: 400 })
  }

  // Only our three known censor styles may reach the worker.
  if (typeof muteType !== 'string' || !ALLOWED_MUTE_TYPES.has(muteType)) {
    return NextResponse.json({ error: 'Invalid muteType' }, { status: 400 })
  }

  // Bound free-text fields so oversized payloads can't bloat the DB / logs.
  const safeFilename = String(originalFilename).slice(0, 300)
  const manualLyrics = body.manualLyrics ? String(body.manualLyrics).slice(0, 20000) : null
  const geniusLyrics = body.geniusLyrics ? String(body.geniusLyrics).slice(0, 40000) : null

  // 5. Create song record in DB (status 'processing' until the worker finishes)
  const { error: songErr } = await adminSupabase.from('songs').insert({
    id: songId,
    user_id: user.id,
    original_filename: safeFilename,
    original_url: originalUrl,
    status: 'processing',
    words_detected: [],
  })

  if (songErr) {
    console.error('[process] Song INSERT failed:', songErr.message)
    return NextResponse.json({ error: 'Could not start processing. Please try again.' }, { status: 500 })
  }

  // 6. Enqueue the processing job for the Railway worker. The browser subscribes
  //    to this row via Supabase Realtime and reacts to status transitions.
  const { data: job, error: jobErr } = await adminSupabase
    .from('processing_jobs')
    .insert({
      user_id: user.id,
      song_id: songId,
      job_type: 'process',
      status: 'pending',
      source_type: 'upload',
      source_url: originalUrl,
      original_filename: safeFilename,
      mute_type: muteType,
      manual_lyrics: manualLyrics,
      genius_lyrics: geniusLyrics,
    })
    .select('id')
    .single()

  if (jobErr || !job) {
    console.error('[process] Job INSERT failed:', jobErr?.message)
    // Roll the song back to failed so it doesn't dangle in 'processing' forever.
    await adminSupabase.from('songs').update({ status: 'failed' }).eq('id', songId)
    return NextResponse.json({ error: 'Could not start processing. Please try again.' }, { status: 500 })
  }

  console.log(`[process] Enqueued job ${job.id} for song ${songId} (upload)`)

  return NextResponse.json({ success: true, jobId: job.id, songId })
}
