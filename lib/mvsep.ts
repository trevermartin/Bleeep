/* eslint-disable @typescript-eslint/no-explicit-any */

const MVSEP_CREATE_URL = 'https://mvsep.com/api/separation/create'
const MVSEP_GET_URL = 'https://mvsep.com/api/separation/get'
const POLL_INTERVAL_MS = 4000

export interface MvsepStems {
  vocals: string | null
  instrumental: string | null
}

const lc = (f: any): string => (f?.name ?? f?.filename ?? '').toLowerCase()
const urlOf = (f: any): string | undefined => f?.url ?? f?.download_url

function isVocals(name: string): boolean {
  return (
    name.includes('vocal') &&
    !name.includes('no_vocal') &&
    !name.includes('novocal') &&
    !name.includes('no vocal') &&
    !name.includes('instrument')
  )
}

function isInstrumental(name: string): boolean {
  return (
    name.includes('instrument') ||
    name.includes('no_vocal') ||
    name.includes('novocal') ||
    name.includes('no vocal') ||
    name.includes('accompan') ||
    name.includes('music')
  )
}

/**
 * Submits audio at `audioUrl` to MVSEP and isolates the vocal + instrumental
 * stems. Polls until separation is ready or `timeoutMs` elapses.
 *
 * Returns { vocals, instrumental } URLs (either may be null if a stem wasn't
 * found), or null on total failure/timeout so callers can fall back to the
 * full mix.
 *
 * Output is requested as WAV (lossless): MP3 stems carry encoder/decoder delay
 * (~50-100ms of leading padding) which would shift every transcript timestamp
 * relative to the original full mix played in the review waveform. WAV is
 * sample-aligned with the source, keeping transcript clicks and playback in
 * perfect sync.
 *
 * sep_type 'mdx23c' = MDX23C model (2-stem: vocals + no_vocals).
 */
export async function separateStemsMVSEP(
  audioUrl: string,
  timeoutMs = 45000
): Promise<MvsepStems | null> {
  const apiKey = process.env.MVSEP_API_KEY
  if (!apiKey) {
    console.warn('[mvsep] MVSEP_API_KEY not set — skipping vocal isolation')
    return null
  }

  try {
    // Submit job via URL link (avoids downloading the file server-side)
    const form = new FormData()
    form.append('api_token', apiKey)
    form.append('sep_type', 'mdx23c')
    form.append('add_opt', JSON.stringify({ return_format: 'wav' }))
    form.append('link', audioUrl)

    console.log('[mvsep] Submitting separation job...')
    const createRes = await fetch(MVSEP_CREATE_URL, { method: 'POST', body: form })
    if (!createRes.ok) {
      console.warn(`[mvsep] Create request failed: HTTP ${createRes.status}`)
      return null
    }

    const createData = (await createRes.json()) as any
    // Hash may be top-level or nested under .data
    const hash: string | undefined = createData?.hash ?? createData?.data?.hash
    if (!hash) {
      console.warn('[mvsep] No hash in response:', JSON.stringify(createData).slice(0, 300))
      return null
    }
    console.log(`[mvsep] Job queued. hash=${hash}, timeout=${timeoutMs}ms`)

    // Poll until separation completes or timeout
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS))

      const pollRes = await fetch(
        `${MVSEP_GET_URL}?hash=${encodeURIComponent(hash)}&api_token=${encodeURIComponent(apiKey)}`
      )
      if (!pollRes.ok) continue

      const pollData = (await pollRes.json()) as any
      // Output files may be in .data or .files depending on API version
      const files: any[] = pollData?.data ?? pollData?.files ?? []

      if (files.length > 0) {
        const vocalsFile = files.find((f) => isVocals(lc(f)))
        let instrFile = files.find((f) => isInstrumental(lc(f)))
        // 2-stem model with unrecognized naming: the non-vocals file is the instrumental
        if (vocalsFile && !instrFile && files.length === 2) {
          instrFile = files.find((f) => f !== vocalsFile)
        }

        const vocals = vocalsFile ? urlOf(vocalsFile) ?? null : null
        const instrumental = instrFile ? urlOf(instrFile) ?? null : null

        if (vocals || instrumental) {
          console.log(
            `[mvsep] Stems ready — vocals=${vocals ? 'yes' : 'no'} instrumental=${instrumental ? 'yes' : 'no'}`
          )
          return { vocals, instrumental }
        }
      }

      const remaining = Math.ceil((deadline - Date.now()) / 1000)
      console.log(`[mvsep] Still processing... ${remaining}s remaining`)
    }

    console.warn('[mvsep] Timed out — will fall back to full-mix processing')
    return null
  } catch (err) {
    console.warn('[mvsep] Error:', err instanceof Error ? err.message : String(err))
    return null
  }
}
