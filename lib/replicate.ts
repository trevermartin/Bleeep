/**
 * Replicate-hosted Demucs (https://replicate.com/adirik/demucs) for vocal
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

/** Resolve the latest version hash of adirik/demucs (not hardcoded so model updates don't break us). */
async function getDemucsVersion(token: string): Promise<string> {
  const res = await fetch(`${REPLICATE_API}/models/adirik/demucs`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Replicate model lookup failed: HTTP ${res.status}`)
  const model = await res.json()
  const version = model?.latest_version?.id
  if (!version) throw new Error('Replicate: could not resolve demucs model version')
  return version
}

/**
 * Separate a track into vocals + instrumental.
 * Returns URLs to the two stems hosted by Replicate (valid ~1 hour).
 */
export async function separateVocals(
  audioUrl: string
): Promise<{ vocalsUrl: string; instrumentalUrl: string }> {
  const token = process.env.REPLICATE_API_TOKEN
  if (!token) throw new Error('REPLICATE_API_TOKEN is not set')

  const version = await getDemucsVersion(token)

  console.log('[replicate] Submitting demucs prediction...')
  const createRes = await fetch(`${REPLICATE_API}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      version,
      input: {
        audio: audioUrl,
        model_name: 'htdemucs',
        // Two-stem mode: vocals + everything else (no_vocals)
        stem: 'vocals',
        output_format: 'mp3',
      },
    }),
  })

  if (!createRes.ok) {
    const errText = await createRes.text()
    throw new Error(`Replicate submit failed (${createRes.status}): ${errText.slice(0, 300)}`)
  }

  const { id } = (await createRes.json()) as PredictionResponse
  console.log(`[replicate] Prediction ID: ${id}`)

  // Poll until done — Demucs typically takes 20-60s on GPU
  const maxAttempts = 80 // ~4 min at 3s intervals
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const res = await fetch(`${REPLICATE_API}/predictions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Replicate poll failed: HTTP ${res.status}`)
    const pred = (await res.json()) as PredictionResponse

    if (pred.status === 'succeeded') {
      const stems = extractStems(pred.output)
      if (!stems) throw new Error('Replicate: demucs output missing vocals/instrumental stems')
      console.log('[replicate] Demucs separation complete')
      return stems
    }
    if (pred.status === 'failed' || pred.status === 'canceled') {
      throw new Error(`Replicate demucs ${pred.status}: ${pred.error ?? 'unknown error'}`)
    }
  }
  throw new Error('Replicate demucs timed out after 4 minutes')
}

/** Pull vocals + instrumental URLs out of the prediction output, tolerating key naming differences. */
function extractStems(
  output: PredictionResponse['output']
): { vocalsUrl: string; instrumentalUrl: string } | null {
  if (!output || Array.isArray(output)) return null
  const vocalsUrl = output.vocals
  const instrumentalUrl = output.no_vocals ?? output.instrumental ?? output.other
  if (!vocalsUrl || !instrumentalUrl) return null
  return { vocalsUrl, instrumentalUrl }
}
