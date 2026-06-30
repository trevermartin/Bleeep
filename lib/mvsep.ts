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
  const t0 = Date.now()
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`

  const apiKey = process.env.MVSEP_API_KEY
  console.log(
    `[mvsep] separateStemsMVSEP() invoked. apiKeyPresent=${!!apiKey} timeoutMs=${timeoutMs} audioUrl=${audioUrl}`
  )
  if (!apiKey) {
    console.warn('[mvsep] MVSEP_API_KEY not set — skipping vocal isolation, returning null')
    return null
  }

  try {
    // MVSEP's create endpoint requires the actual audio bytes as a multipart
    // file upload — passing a `link` URL returns HTTP 400 "File not uploaded".
    // So download the source from Supabase first, then upload the buffer.
    console.log('[mvsep] Downloading source audio for upload...')
    const srcRes = await fetch(audioUrl)
    if (!srcRes.ok) {
      console.warn(`[mvsep] Failed to download source audio: HTTP ${srcRes.status} — returning null`)
      return null
    }
    const srcBuf = Buffer.from(await srcRes.arrayBuffer())

    // Derive a filename + mime type for the upload part.
    let filename = 'audio.mp3'
    try {
      const base = new URL(audioUrl).pathname.split('/').pop()
      if (base) filename = decodeURIComponent(base)
    } catch {
      // keep default
    }
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
    const headerType = srcRes.headers.get('content-type') ?? ''
    const mime = headerType.startsWith('audio/')
      ? headerType
      : ext === '.wav'
        ? 'audio/wav'
        : ext === '.flac'
          ? 'audio/flac'
          : ext === '.m4a'
            ? 'audio/mp4'
            : 'audio/mpeg'
    console.log(`[mvsep] Source downloaded: ${srcBuf.length}B filename="${filename}" mime=${mime}`)

    const form = new FormData()
    form.append('api_token', apiKey)
    form.append('sep_type', 'mdx23c')
    form.append('add_opt', JSON.stringify({ return_format: 'wav' }))
    form.append('audiofile', new Blob([srcBuf], { type: mime }), filename)

    console.log('[mvsep] POST /separation/create (multipart file upload, sep_type=mdx23c, return_format=wav)...')
    const createRes = await fetch(MVSEP_CREATE_URL, { method: 'POST', body: form })
    const createText = await createRes.text()
    console.log(
      `[mvsep] create response: HTTP ${createRes.status} ${createRes.statusText} | body=${createText.slice(0, 2000)}`
    )
    if (!createRes.ok) {
      console.warn(`[mvsep] Create request failed (HTTP ${createRes.status}) — returning null`)
      return null
    }

    let createData: any
    try {
      createData = JSON.parse(createText)
    } catch {
      console.warn('[mvsep] Create response was not valid JSON — returning null')
      return null
    }
    // Hash may be top-level or nested under .data
    const hash: string | undefined = createData?.hash ?? createData?.data?.hash
    if (!hash) {
      console.warn('[mvsep] No hash in create response — returning null. Full response logged above.')
      return null
    }
    console.log(`[mvsep] Job queued. hash=${hash} timeout=${timeoutMs}ms`)

    // Poll until separation completes or timeout
    const deadline = Date.now() + timeoutMs
    let pollCount = 0
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS))
      pollCount++

      const pollRes = await fetch(
        `${MVSEP_GET_URL}?hash=${encodeURIComponent(hash)}&api_token=${encodeURIComponent(apiKey)}`
      )
      if (!pollRes.ok) {
        console.warn(`[mvsep] poll #${pollCount} (${elapsed()}): HTTP ${pollRes.status} — retrying`)
        continue
      }

      const pollText = await pollRes.text()
      let pollData: any
      try {
        pollData = JSON.parse(pollText)
      } catch {
        console.warn(`[mvsep] poll #${pollCount} (${elapsed()}): non-JSON body=${pollText.slice(0, 500)}`)
        continue
      }

      // Output files may be in .data or .files depending on API version. .data
      // can also be an OBJECT wrapping a files array rather than an array.
      const rawData = pollData?.data
      const files: any[] = Array.isArray(rawData)
        ? rawData
        : Array.isArray(rawData?.files)
          ? rawData.files
          : Array.isArray(pollData?.files)
            ? pollData.files
            : []

      console.log(
        `[mvsep] poll #${pollCount} (${elapsed()}): status=${pollData?.status ?? '?'} success=${pollData?.success ?? '?'} ` +
          `dataType=${Array.isArray(rawData) ? 'array' : typeof rawData} fileCount=${files.length} | ` +
          `raw=${pollText.slice(0, 1500)}`
      )

      if (files.length > 0) {
        console.log(
          `[mvsep] poll #${pollCount} files: ${files
            .map((f, i) => `[${i}] name="${lc(f)}" url=${urlOf(f) ?? 'none'}`)
            .join(' | ')}`
        )
        const vocalsFile = files.find((f) => isVocals(lc(f)))
        let instrFile = files.find((f) => isInstrumental(lc(f)))
        // 2-stem model with unrecognized naming: the non-vocals file is the instrumental
        if (vocalsFile && !instrFile && files.length === 2) {
          instrFile = files.find((f) => f !== vocalsFile)
          console.log('[mvsep] instrumental matched by elimination (2-file fallback)')
        }

        const vocals = vocalsFile ? urlOf(vocalsFile) ?? null : null
        const instrumental = instrFile ? urlOf(instrFile) ?? null : null

        if (vocals || instrumental) {
          console.log(
            `[mvsep] DONE in ${elapsed()} after ${pollCount} poll(s) — vocals=${vocals ?? 'null'} instrumental=${instrumental ?? 'null'}`
          )
          return { vocals, instrumental }
        }
        console.warn(
          '[mvsep] files present but neither matched isVocals/isInstrumental — see file names above'
        )
      }
    }

    console.warn(
      `[mvsep] TIMED OUT after ${elapsed()} / ${pollCount} poll(s) — separation not ready, returning null (full-mix fallback)`
    )
    return null
  } catch (err) {
    console.warn(`[mvsep] ERROR after ${elapsed()}:`, err instanceof Error ? err.stack ?? err.message : String(err))
    return null
  }
}
