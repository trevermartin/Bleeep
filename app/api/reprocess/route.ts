import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import type { DetectedWord } from '@/types'

const ALLOWED_MUTE_TYPES = new Set(['mute', 'warp', 'bleep'])
const MAX_WORDS = 500
const MAX_TIME_SEC = 24 * 60 * 60 // 24h — comfortably longer than any track

/**
 * Sanitize the client-supplied word list before it is persisted and rendered.
 * start/end feed directly into the worker's ffmpeg filtergraph, so they must be
 * finite, ordered, non-negative numbers — never strings that could smuggle
 * filtergraph syntax. Anything malformed is dropped rather than trusted.
 */
function sanitizeWords(input: unknown): DetectedWord[] | null {
  if (!Array.isArray(input)) return null
  if (input.length > MAX_WORDS) return null
  const out: DetectedWord[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const w = raw as Record<string, unknown>
    const start = Number(w.start)
    const end = Number(w.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (start < 0 || end <= start || end > MAX_TIME_SEC) continue
    const muteType = typeof w.mute_type === 'string' && ALLOWED_MUTE_TYPES.has(w.mute_type)
      ? (w.mute_type as DetectedWord['mute_type'])
      : 'mute'
    const word = typeof w.word === 'string' ? w.word.slice(0, 100) : 'word'
    out.push({ word, start, end, mute_type: muteType })
  }
  return out
}

// Thin job-creator. The post-edit re-render (mute/warp the user-confirmed word
// list, reusing the cached MVSEP stems) now runs on the Railway worker. This
// route verifies ownership, flips the song back to 'processing', and enqueues a
// 'reprocess' job the worker claims. The browser subscribes to the returned
// jobId via Supabase Realtime.

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
    songId: string
    wordsDetected: DetectedWord[]
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { songId } = body

  if (!songId || typeof songId !== 'string' || !/^[0-9a-f-]{36}$/i.test(songId)) {
    return NextResponse.json({ error: 'Missing or invalid songId' }, { status: 400 })
  }

  const wordsDetected = sanitizeWords(body.wordsDetected ?? [])
  if (wordsDetected === null) {
    return NextResponse.json({ error: 'Invalid word list' }, { status: 400 })
  }

  // Verify the song belongs to this user before enqueueing a render for it.
  const { data: song } = await adminSupabase
    .from('songs')
    .select('id')
    .eq('id', songId)
    .eq('user_id', user.id)
    .single()

  if (!song) return NextResponse.json({ error: 'Song not found' }, { status: 404 })

  // Flip the song back to 'processing' so the library reflects the in-flight
  // re-render immediately (the worker flips it to complete/failed).
  await adminSupabase.from('songs').update({ status: 'processing' }).eq('id', songId)

  // Enqueue the reprocess job. The worker reads the persisted stems + filename
  // from the songs row, so we only need to hand it the edited word list.
  const { data: job, error: jobErr } = await adminSupabase
    .from('processing_jobs')
    .insert({
      user_id: user.id,
      song_id: songId,
      job_type: 'reprocess',
      status: 'pending',
      words_detected: wordsDetected,
    })
    .select('id')
    .single()

  if (jobErr || !job) {
    console.error('[reprocess] Job INSERT failed:', jobErr?.message)
    await adminSupabase.from('songs').update({ status: 'failed' }).eq('id', songId)
    return NextResponse.json({ error: 'Could not start re-render. Please try again.' }, { status: 500 })
  }

  console.log(`[reprocess] Enqueued job ${job.id} for song ${songId} (${wordsDetected.length} words)`)

  return NextResponse.json({ success: true, jobId: job.id, songId })
}
