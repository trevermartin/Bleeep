import { supabase } from './supabase'
import { runJob } from './pipeline'
import type { ProcessingJob } from './types'

// Process one job at a time per worker instance: skip ticks while busy so a
// long render can't overlap with the next claim.
let busy = false

async function tick(): Promise<void> {
  if (busy) return
  busy = true
  try {
    // Find the oldest pending job.
    const { data: pending, error: findErr } = await supabase
      .from('processing_jobs')
      .select('id')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)

    if (findErr) {
      console.error('[poller] pending lookup failed:', findErr.message)
      return
    }
    if (!pending || pending.length === 0) return

    const jobId = pending[0].id as string

    // Atomic claim: only succeeds if the row is STILL pending. If another
    // instance grabbed it first, the status filter matches 0 rows → null data.
    const { data: claimed, error: claimErr } = await supabase
      .from('processing_jobs')
      .update({ status: 'claimed' })
      .eq('id', jobId)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle()

    if (claimErr) {
      console.error(`[poller] claim failed for ${jobId}:`, claimErr.message)
      return
    }
    if (!claimed) {
      // Lost the race — another worker claimed it. Try again next tick.
      return
    }

    const job = claimed as ProcessingJob
    console.log(`[poller] claimed job ${job.id} (type=${job.job_type}, song=${job.song_id})`)

    try {
      await runJob(job)
    } catch (err) {
      // Mark the job + song failed without crashing the loop.
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[poller] job ${job.id} FAILED:`, err)
      await supabase
        .from('processing_jobs')
        .update({ status: 'failed', error_message: message })
        .eq('id', job.id)
      await supabase.from('songs').update({ status: 'failed' }).eq('id', job.song_id)
    }
  } catch (err) {
    // Never let a tick throw past here — the loop must survive.
    console.error('[poller] tick error:', err)
  } finally {
    busy = false
  }
}

/** Start the background polling loop. */
export function startPoller(): void {
  const interval = Number(process.env.POLL_INTERVAL_MS) || 4000
  console.log(`[poller] starting — polling every ${interval}ms`)
  setInterval(() => {
    void tick()
  }, interval)
}
