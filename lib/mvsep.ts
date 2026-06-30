/* eslint-disable @typescript-eslint/no-explicit-any */

const MVSEP_CREATE_URL = 'https://mvsep.com/api/separation/create'
const MVSEP_GET_URL = 'https://mvsep.com/api/separation/get'
const POLL_INTERVAL_MS = 4000

/**
 * Submits audio at `audioUrl` to MVSEP for vocal isolation.
 * Polls until the vocals stem is ready or `timeoutMs` elapses.
 * Returns the public URL of the vocals-only file, or null on timeout/error.
 *
 * sep_type 'mdx23c' = MDX23C model (2-stem: vocals + no_vocals).
 * Update to 'bs_roformer_vocals' or 'htdemucs' if your account supports them.
 */
export async function separateVocalsMVSEP(
  audioUrl: string,
  timeoutMs = 45000
): Promise<string | null> {
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
    form.append('add_opt', JSON.stringify({ return_format: 'mp3' }))
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
        // Prefer the file whose name contains "vocal" but not "no_vocal"/"instrumental"
        const vocalsFile =
          files.find((f: any) => {
            const name: string = (f.name ?? f.filename ?? '').toLowerCase()
            return (
              name.includes('vocal') &&
              !name.includes('no_vocal') &&
              !name.includes('novocal') &&
              !name.includes('instrumental')
            )
          }) ?? files[0]

        const url: string | undefined = vocalsFile?.url ?? vocalsFile?.download_url
        if (url) {
          console.log(`[mvsep] Vocals stem ready: ${url}`)
          return url
        }
      }

      const remaining = Math.ceil((deadline - Date.now()) / 1000)
      console.log(`[mvsep] Still processing... ${remaining}s remaining`)
    }

    console.warn('[mvsep] Timed out after 45s — will fall back to full-mix transcription')
    return null
  } catch (err) {
    console.warn('[mvsep] Error:', err instanceof Error ? err.message : String(err))
    return null
  }
}
