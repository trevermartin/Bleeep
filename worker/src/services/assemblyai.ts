/**
 * AssemblyAI transcription service.
 *
 * Extracted from the Vercel app's app/api/process/route.ts (the inline submit +
 * pollAssemblyAI logic). Behaviour is unchanged except the poll cap is raised:
 * the worker transcribes FULL-length songs (no 60s serverless wall), so the
 * old ~5min cap is widened to ~10min to avoid clipping long tracks.
 */

/** Raw AssemblyAI word: text + ms timestamps. */
export interface AssemblyWord {
  text: string
  start: number // milliseconds
  end: number // milliseconds
}

async function pollAssemblyAI(transcriptId: string, apiKey: string): Promise<any> {
  const maxAttempts = 200 // ~10 min at 3s intervals
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const res = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { authorization: apiKey },
    })
    if (!res.ok) throw new Error(`AssemblyAI poll failed: ${res.status}`)
    const data = (await res.json()) as any
    if (data.status === 'completed') return data
    if (data.status === 'error') throw new Error(`AssemblyAI error: ${data.error}`)
  }
  throw new Error('AssemblyAI transcription timed out after 10 minutes')
}

/**
 * Submit `audioUrl` to AssemblyAI and return its word-level transcript.
 *
 * `keyterms` are passed as keyterms_prompt to bias recognition toward the
 * profanity word-boost list plus any Genius lyric tokens. Profanity filtering
 * is disabled so the model never pre-censors the words we need to detect.
 */
export async function transcribeAudio(opts: {
  audioUrl: string
  keyterms: string[]
  apiKey: string
}): Promise<AssemblyWord[]> {
  const { audioUrl, keyterms, apiKey } = opts

  console.log(`[assemblyai] Submitting transcript with audio_url=${audioUrl}`)
  const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speech_models: ['universal-3-pro'],
      // profanity_filter OFF — never let AssemblyAI pre-censor words
      filter_profanity: false,
      keyterms_prompt: keyterms,
    }),
  })

  if (!submitRes.ok) {
    const errText = await submitRes.text()
    throw new Error(`AssemblyAI submit failed (${submitRes.status}): ${errText}`)
  }

  const { id: transcriptId } = (await submitRes.json()) as { id: string }
  console.log(`[assemblyai] transcript ID: ${transcriptId}`)

  const transcript = await pollAssemblyAI(transcriptId, apiKey)
  console.log(`[assemblyai] Transcription complete. Words: ${transcript.words?.length ?? 0}`)

  return (transcript.words || []) as AssemblyWord[]
}
