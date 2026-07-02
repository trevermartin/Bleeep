import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import type { DetectedWord } from '@/types'

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

  const { songId, wordsDetected = [] } = body

  if (!songId) {
    return NextResponse.json({ error: 'Missing required field: songId' }, { status: 400 })
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
    return NextResponse.json(
      { error: `Could not enqueue reprocess job: ${jobErr?.message ?? 'unknown'}` },
      { status: 500 }
    )
  }

  console.log(`[reprocess] Enqueued job ${job.id} for song ${songId} (${wordsDetected.length} words)`)

  return NextResponse.json({ success: true, jobId: job.id, songId })
}
