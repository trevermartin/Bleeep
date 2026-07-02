import { createClient } from '@/lib/supabase/client'
import type { DetectedWord } from '@/types'

// Browser-side subscription to a Railway worker job. Vercel enqueues a
// processing_jobs row and returns its id; the worker updates that row's `status`
// after each pipeline stage. We subscribe via Supabase Realtime so the
// dashboard reflects live progress and picks up the result without polling.

export interface JobRow {
  id: string
  song_id: string
  status: string
  words_detected: DetectedWord[] | null
  transcript: Array<{ word: string; start: number; end: number }> | null
  detection_method: 'ai' | 'lyrics' | 'community' | null
  error_message: string | null
}

export interface JobSongRow {
  id: string
  original_url: string | null
  original_filename: string | null
  clean_url: string | null
  status: string
}

export interface JobCompletion {
  job: JobRow
  song: JobSongRow | null
}

export interface SubscribeHandlers {
  onStage?: (status: string) => void
  onComplete: (result: JobCompletion) => void
  onError: (message: string) => void
}

const TERMINAL = new Set(['complete', 'failed'])

// The worker can legitimately run several minutes on long tracks (MVSEP +
// AssemblyAI). This only bounds the *live UI* — the worker persists results to
// the songs table regardless, so a timeout just sends the user to their
// history rather than losing the render.
const SAFETY_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Subscribe to a job's status transitions. Returns an unsubscribe function the
 * caller MUST invoke on unmount (and before starting another job). `onComplete`
 * and `onError` fire at most once; the channel is torn down on either.
 */
export function subscribeToJob(jobId: string, handlers: SubscribeHandlers): () => void {
  const supabase = createClient()
  let settled = false
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const channel = supabase.channel(`job-${jobId}`)

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    void supabase.removeChannel(channel)
  }

  const settle = async (status: string, errorMessage: string | null) => {
    if (settled) return
    settled = true
    try {
      if (status === 'complete') {
        const { data: job } = await supabase
          .from('processing_jobs')
          .select('id, song_id, status, words_detected, transcript, detection_method, error_message')
          .eq('id', jobId)
          .single()

        let song: JobSongRow | null = null
        if (job?.song_id) {
          const { data: s } = await supabase
            .from('songs')
            .select('id, original_url, original_filename, clean_url, status')
            .eq('id', job.song_id)
            .single()
          song = (s as JobSongRow) ?? null
        }
        handlers.onComplete({ job: job as JobRow, song })
      } else {
        handlers.onError(errorMessage || 'Processing failed. Please try again.')
      }
    } catch (err) {
      handlers.onError(err instanceof Error ? err.message : 'Processing failed.')
    } finally {
      cleanup()
    }
  }

  // Catch the race where the job advances (or finishes) between INSERT and our
  // subscription being established — postgres_changes only delivers events that
  // occur AFTER subscribe() returns SUBSCRIBED.
  const initialCheck = async () => {
    if (settled) return
    const { data: job } = await supabase
      .from('processing_jobs')
      .select('status, error_message')
      .eq('id', jobId)
      .single()
    if (!job || settled) return
    if (TERMINAL.has(job.status)) void settle(job.status, job.error_message)
    else handlers.onStage?.(job.status)
  }

  channel
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'processing_jobs', filter: `id=eq.${jobId}` },
      (payload) => {
        const row = payload.new as { status: string; error_message: string | null }
        if (TERMINAL.has(row.status)) void settle(row.status, row.error_message)
        else handlers.onStage?.(row.status)
      }
    )
    .subscribe((subStatus) => {
      if (subStatus === 'SUBSCRIBED') void initialCheck()
    })

  timeoutId = setTimeout(() => {
    void settle(
      'failed',
      'This is taking longer than expected — your song may still finish in the background. Check your song history in a minute.'
    )
  }, SAFETY_TIMEOUT_MS)

  return cleanup
}
