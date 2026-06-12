/**
 * Replicate-hosted Demucs (https://replicate.com/cjwbw/demucs) for vocal
 * isolation. Demucs can't run on Vercel directly (model weights too large),
 * so we send the audio URL to Replicate and poll for the separated stems.
 */

const REPLICATE_API = 'https://api.replicate.com/v1'

interface PredictionResponse {
  id: string
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'
  output: Record<string, string> | string[] | null
  error: string | null
}

/**
 * Separate a track into vocals + instrumental via Replicate Demucs.
 * Returns Replicate-hosted URLs for the two stems (valid ~1 hour).
 *
 * Uses the /models/{owner}/{name}/predictions endpoint directly —
 * no version-hash lookup needed, which was the previous failure point.
 */
export async function separateVocals(
  audioUrl: string
): Promise<{ vocalsUrl: string; instrumentalUrl: string }> {
  const token = process.env.REPLICATE_API_TOKEN
  if (!token) throw new Error('REPLICATE_API_TOKEN is not set')

  console.log(`[replicate] Token present (${token.length} chars). Submitting demucs for: ${audioUrl.slice(0, 100)}`)

  const createRes = await fetch(`${REPLICATE_API}/models/cjwbw/demucs/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: {
        audio: audioUrl,
        // Two-stem mode: returns "vocals" + "no_vocals" (instrumental) URLs
        two_stems: 'vocals',
      },
    }),
  })

  if (!createRes.ok) {
    const errText = await createRes.text()
    throw new Error(`Replicate submit failed (${createRes.status}): ${errText.slice(0, 500)}`)
  }

  const initial = (await createRes.json()) as PredictionResponse
  console.log(`[replicate] Prediction created: id=${initial.id} status=${initial.status}`)

  // Handle the rare case where it completes synchronously
  if (initial.status === 'succeeded') {
    const stems = extractStems(initial.output)
    console.log(`[replicate] Completed immediately. Output: ${describeOutput(initial.output)}`)
    if (!stems) throw new Error(`Replicate: demucs output missing vocals/no_vocals. Got: ${describeOutput(initial.output)}`)
    return stems
  }

  // Poll until done — Demucs typically takes 20-60s on GPU
  const maxAttempts = 80 // ~4 min at 3s intervals
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000))

    const pollRes = await fetch(`${REPLICATE_API}/predictions/${initial.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!pollRes.ok) throw new Error(`Replicate poll failed: HTTP ${pollRes.status}`)
    const pred = (await pollRes.json()) as PredictionResponse

    console.log(`[replicate] Poll ${i + 1}/${maxAttempts}: status=${pred.status}`)

    if (pred.status === 'succeeded') {
      console.log(`[replicate] Output: ${describeOutput(pred.output)}`)
      const stems = extractStems(pred.output)
      if (!stems) throw new Error(`Replicate: demucs output missing vocals/no_vocals. Got: ${describeOutput(pred.output)}`)
      console.log('[replicate] Demucs separation complete — vocals and instrumental ready')
      return stems
    }

    if (pred.status === 'failed' || pred.status === 'canceled') {
      throw new Error(`Replicate demucs ${pred.status}: ${pred.error ?? 'unknown error'}`)
    }
  }

  throw new Error('Replicate demucs timed out after 4 minutes')
}

/** Describe the prediction output for logging without printing full URLs. */
function describeOutput(output: PredictionResponse['output']): string {
  if (!output) return 'null'
  if (Array.isArray(output)) return `array[${output.length}]`
  return `{${Object.keys(output).join(', ')}}`
}

/** Pull vocals + instrumental URLs from prediction output, tolerating key name variations. */
function extractStems(
  output: PredictionResponse['output']
): { vocalsUrl: string; instrumentalUrl: string } | null {
  if (!output || Array.isArray(output)) return null
  const vocalsUrl = output.vocals
  const instrumentalUrl = output.no_vocals ?? output.instrumental ?? output.other
  if (!vocalsUrl || !instrumentalUrl) return null
  return { vocalsUrl, instrumentalUrl }
}
