import fs from 'fs'
import os from 'os'
import path from 'path'
import { supabase } from './supabase'
import type { DetectedWord, JobStatus, ProcessingJob, TranscriptWord } from './types'
import { separateStemsMVSEP, type MvsepStems } from './services/mvsep'
import { transcribeAudio } from './services/assemblyai'
import { renderCleanAudio, downloadToFile } from './services/audio'
import { isProfane, WORD_BOOST } from './services/profanity'
import { parseFilename, parseLrc, detectProfanityInLyrics } from './services/lrclib'
import { trackFingerprint } from './services/fingerprint'
import {
  buildFilename,
  downloadSoundCloudMp3,
  fetchSoundCloudMetadata,
} from './services/ytdlp'

const BUCKET = 'audio'

/** Update the processing_jobs row's stage (Realtime pushes this to the browser). */
async function setJobStatus(
  jobId: string,
  status: JobStatus,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await supabase
    .from('processing_jobs')
    .update({ status, ...extra })
    .eq('id', jobId)
  if (error) console.warn(`[pipeline] failed to set job ${jobId} → ${status}: ${error.message}`)
  else console.log(`[pipeline] job ${jobId} → ${status}`)
}

function publicUrl(storagePath: string): string {
  return supabase.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl
}

/** Dispatch a claimed job to the matching pipeline. */
export async function runJob(job: ProcessingJob): Promise<void> {
  if (job.job_type === 'reprocess') {
    await runReprocessJob(job)
  } else {
    await runProcessJob(job)
  }
}

// ── Full pipeline: download → isolate → transcribe → render ────────────────────

async function runProcessJob(job: ProcessingJob): Promise<void> {
  const tmpDir = os.tmpdir()
  const tmpFiles: string[] = []
  const muteType = job.mute_type

  // MVSEP stems are needed both for transcription (vocals) and the vocal-only
  // render (vocals + instrumental). Run separation at most once and cache it.
  // undefined = not attempted, null = attempted but unavailable.
  let computedStems: MvsepStems | null = null
  let stemsAttempted = false
  const getStems = async (sourceUrl: string): Promise<MvsepStems | null> => {
    if (!stemsAttempted) {
      stemsAttempted = true
      computedStems = await separateStemsMVSEP(sourceUrl)
    }
    return computedStems
  }
  // Typed accessor: reading the closure-mutated variable directly makes TS
  // flow-narrow it to its `null` initializer (then `null?.vocals` is `never`).
  // The explicit return type here preserves MvsepStems | null at the call site.
  const peekStems = (): MvsepStems | null => computedStems

  try {
    // ── Stage: downloading — resolve the original audio URL + filename ────────
    await setJobStatus(job.id, 'downloading')

    let originalUrl: string
    let originalFilename: string

    if (job.source_type === 'soundcloud') {
      if (!job.source_url) throw new Error('soundcloud job missing source_url')
      console.log(`[pipeline] SoundCloud download: ${job.source_url}`)
      const meta = await fetchSoundCloudMetadata(job.source_url)
      originalFilename = buildFilename(meta.title || job.song_name || 'Track', meta.artist || job.artist || '')

      const mp3Path = path.join(tmpDir, `sc_${job.song_id}.mp3`)
      tmpFiles.push(mp3Path)
      await downloadSoundCloudMp3(job.source_url, mp3Path)

      const storagePath = `originals/${job.user_id}/${job.song_id}.mp3`
      const buf = fs.readFileSync(mp3Path)
      console.log(`[pipeline] Uploading SoundCloud original (${buf.length}B) → ${storagePath}`)
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, buf, { contentType: 'audio/mpeg', upsert: true })
      if (upErr) throw new Error(`Original upload failed: ${upErr.message}`)
      originalUrl = publicUrl(storagePath)

      // Backfill the songs row so the library + WaveformReview have the real
      // filename/URL (Vercel inserted it with placeholders for soundcloud).
      await supabase
        .from('songs')
        .update({ original_filename: originalFilename, original_url: originalUrl })
        .eq('id', job.song_id)
    } else {
      // Upload jobs: the browser already put the file in storage; source_url is
      // its public URL.
      if (!job.source_url) throw new Error('upload job missing source_url')
      originalUrl = job.source_url
      originalFilename = job.original_filename ?? 'audio.mp3'
    }

    console.log(`[pipeline] originalUrl=${originalUrl} originalFilename="${originalFilename}"`)

    // ── Detection ─────────────────────────────────────────────────────────────
    let detectedWords: DetectedWord[] = []
    let transcriptWords: TranscriptWord[] = []
    let detectionMethod: 'lyrics' | 'ai' | 'community' = 'ai'

    // 6a. Manual pasted LRC — highest priority
    if (job.manual_lyrics && job.manual_lyrics.trim()) {
      const lines = parseLrc(job.manual_lyrics)
      if (lines.length > 0) {
        detectedWords = detectProfanityInLyrics(lines, muteType)
        detectionMethod = 'lyrics'
        console.log(`[pipeline] Manual LRC: ${lines.length} lines, ${detectedWords.length} profane`)
      } else {
        console.log('[pipeline] Manual lyrics provided but no LRC timestamps — falling through')
      }
    }

    const parsed = parseFilename(originalFilename)
    console.log(`[pipeline] Filename → artist="${parsed.artist}" track="${parsed.track}"`)

    // 6b. Community timestamps confirmed by 2+ users skip transcription entirely
    if (detectionMethod === 'ai') {
      try {
        const fingerprint = trackFingerprint(parsed.artist, parsed.track)
        const { data: communityRows, error: communityErr } = await supabase
          .from('song_timestamps')
          .select('timestamps, confidence_score, created_at')
          .eq('track_fingerprint', fingerprint)
          .order('confidence_score', { ascending: false })
          .order('created_at', { ascending: false })

        if (communityErr) {
          console.warn('[pipeline] Community lookup failed:', communityErr.message)
        } else if (communityRows && communityRows.length >= 2) {
          const saved = (communityRows[0].timestamps ?? []) as DetectedWord[]
          detectedWords = saved.map((w) => ({ ...w, mute_type: muteType }))
          detectionMethod = 'community'
          console.log(
            `[pipeline] Community match: ${communityRows.length} confirmations for "${fingerprint}" → ${detectedWords.length} word(s)`
          )
        } else {
          console.log(
            `[pipeline] Community: ${communityRows?.length ?? 0} match(es) for "${fingerprint}" — need 2+, continuing`
          )
        }
      } catch (communityErr) {
        console.warn('[pipeline] Community lookup failed:', communityErr)
      }
    }

    // 7. AssemblyAI transcription (primary path) — runs unless an override above
    //    already produced timestamps. Isolated vocal stem is the preferred
    //    transcription source (WAV stems are sample-aligned with the full mix).
    if (detectionMethod === 'ai') {
      const assemblyApiKey = process.env.ASSEMBLYAI_API_KEY
      if (!assemblyApiKey) throw new Error('ASSEMBLYAI_API_KEY is not set')

      // Genius lyrics (when present) ride alongside the profanity boosts as
      // keyterms to bias recognition toward the real words.
      const keyterms = [...WORD_BOOST]
      if (job.genius_lyrics && job.genius_lyrics.trim()) {
        const lyricTerms = Array.from(
          new Set(
            job.genius_lyrics
              .toLowerCase()
              .replace(/[^a-z0-9\s']/g, ' ')
              .split(/\s+/)
              .filter((t) => t.length > 1)
          )
        )
        keyterms.push(...lyricTerms)
        console.log(`[pipeline] Genius lyrics → ${lyricTerms.length} key terms added for alignment`)
      }

      await setJobStatus(job.id, 'isolating')
      console.log('[pipeline] >>> Requesting MVSEP stems for TRANSCRIPTION source...')
      const s = await getStems(originalUrl)
      console.log(
        `[pipeline] getStems() → ${s ? `vocals=${s.vocals ?? 'null'} instrumental=${s.instrumental ?? 'null'}` : 'null (separation failed/unavailable)'}`
      )
      const transcribeUrl = s?.vocals ?? originalUrl
      console.log(
        `[pipeline] TRANSCRIPTION SOURCE = ${s?.vocals ? 'MVSEP VOCAL STEM' : 'ORIGINAL FULL MIX'} → ${transcribeUrl}`
      )

      await setJobStatus(job.id, 'transcribing')
      const rawWords = await transcribeAudio({ audioUrl: transcribeUrl, keyterms, apiKey: assemblyApiKey })

      // Full transcript (every word) for the clickable review panel
      transcriptWords = rawWords.map((w) => ({
        word: w.text,
        start: w.start / 1000, // ms → seconds
        end: w.end / 1000,
      }))

      detectedWords = rawWords
        .filter((w) => isProfane(w.text))
        .map((w) => ({
          word: w.text,
          start: w.start / 1000,
          end: w.end / 1000,
          mute_type: muteType,
        }))
    }

    console.log(`[pipeline] Detection (${detectionMethod}) found ${detectedWords.length} profane word(s)`)

    // ── Stage: processing — ffmpeg render (only if profanity was found) ───────
    let cleanUrl = originalUrl
    let resultStoragePath: string | null = null

    if (detectedWords.length > 0) {
      await setJobStatus(job.id, 'processing')
      const outputPath = path.join(tmpDir, `bleeep_output_${job.song_id}.mp3`)
      tmpFiles.push(outputPath)

      const s = await getStems(originalUrl)
      console.log(
        `[pipeline] RENDER decision: getStems() → vocals=${s?.vocals ?? 'null'} instrumental=${s?.instrumental ?? 'null'}`
      )

      if (s?.vocals && s?.instrumental) {
        console.log('[pipeline] RENDER PATH = VOCAL-ONLY (mute/warp vocals, instrumental 100% intact)')
        const vocalsPath = path.join(tmpDir, `bleeep_vocals_${job.song_id}.wav`)
        const instrumentalPath = path.join(tmpDir, `bleeep_instrumental_${job.song_id}.wav`)
        tmpFiles.push(vocalsPath, instrumentalPath)
        await downloadToFile(s.vocals, vocalsPath)
        await downloadToFile(s.instrumental, instrumentalPath)
        await renderCleanAudio({ words: detectedWords, outputPath, vocalsPath, instrumentalPath })
      } else {
        const reason = !s
          ? 'separation failed/unavailable'
          : `missing stem (vocals=${s.vocals ? 'ok' : 'null'}, instrumental=${s.instrumental ? 'ok' : 'null'})`
        console.log(`[pipeline] RENDER PATH = FULL-MIX FALLBACK — reason: ${reason}`)
        const ext = path.extname(originalFilename) || '.mp3'
        const inputPath = path.join(tmpDir, `bleeep_input_${job.song_id}${ext}`)
        tmpFiles.push(inputPath)
        await downloadToFile(originalUrl, inputPath)
        await renderCleanAudio({ words: detectedWords, outputPath, inputPath })
      }

      // ── Stage: uploading — push the clean render to storage ─────────────────
      await setJobStatus(job.id, 'uploading')
      resultStoragePath = `clean/${job.user_id}/${job.song_id}_clean.mp3`
      const cleanBuffer = fs.readFileSync(outputPath)
      console.log(`[pipeline] Uploading clean file (${cleanBuffer.length}B) → ${resultStoragePath}`)
      const { error: cleanErr } = await supabase.storage
        .from(BUCKET)
        .upload(resultStoragePath, cleanBuffer, { contentType: 'audio/mpeg', upsert: true })
      if (cleanErr) throw new Error(`Clean file upload failed: ${cleanErr.message}`)
      cleanUrl = publicUrl(resultStoragePath)
      console.log(`[pipeline] Clean file: ${cleanUrl}`)
    }

    // ── Finalize — persist results to songs + processing_jobs ─────────────────
    // Only persist stem URLs if separation was actually attempted, so a 0-word
    // manual/community song doesn't trigger a wasted MVSEP run just to store
    // nulls. Stems let reprocess re-render vocal-only without paying again.
    const finalStems = stemsAttempted ? peekStems() : null

    await supabase
      .from('songs')
      .update({
        clean_url: cleanUrl,
        words_detected: detectedWords,
        status: 'complete',
        original_url: originalUrl,
        original_filename: originalFilename,
        vocals_url: finalStems?.vocals ?? null,
        instrumental_url: finalStems?.instrumental ?? null,
      })
      .eq('id', job.song_id)

    await setJobStatus(job.id, 'complete', {
      words_detected: detectedWords,
      detection_method: detectionMethod,
      transcript: transcriptWords,
      result_storage_path: resultStoragePath,
    })

    // Usage accounting: a successful process job counts against the user's
    // monthly quota. Mirrors the original Vercel route's increment-on-success
    // (Vercel only enforces the limit at job creation; the tally lives here).
    try {
      const { data: prof } = await supabase
        .from('profiles')
        .select('songs_processed_this_month')
        .eq('id', job.user_id)
        .single()
      if (prof) {
        await supabase
          .from('profiles')
          .update({ songs_processed_this_month: (prof.songs_processed_this_month ?? 0) + 1 })
          .eq('id', job.user_id)
      }
    } catch (e) {
      console.warn('[pipeline] usage increment failed (non-fatal):', e)
    }

    console.log(
      `[pipeline] Done. job=${job.id} song=${job.song_id} method=${detectionMethod} words=${detectedWords.length}`
    )
  } finally {
    cleanupTmp(tmpFiles)
  }
}

// ── Reprocess pipeline: re-render the user-edited word list (reuse cached stems)

async function runReprocessJob(job: ProcessingJob): Promise<void> {
  const tmpDir = os.tmpdir()
  const tmpFiles: string[] = []
  const words = job.words_detected ?? []

  console.log(`[pipeline] reprocess job=${job.id} song=${job.song_id} words=${words.length}`)

  try {
    const { data: song, error: songErr } = await supabase
      .from('songs')
      .select('id, original_url, original_filename, vocals_url, instrumental_url')
      .eq('id', job.song_id)
      .single()
    if (songErr || !song) throw new Error(`Song not found: ${songErr?.message ?? job.song_id}`)

    const originalUrl: string = song.original_url ?? job.source_url ?? ''
    const originalFilename: string = song.original_filename ?? job.original_filename ?? 'audio.mp3'

    let cleanUrl = originalUrl
    let resultStoragePath: string | null = null

    if (words.length > 0) {
      await setJobStatus(job.id, 'processing')
      const outputPath = path.join(tmpDir, `bleeep_repr_out_${job.song_id}.mp3`)
      tmpFiles.push(outputPath)

      // Reuse persisted MVSEP stems when available: mute/warp the vocals only
      // and recombine with the untouched instrumental. Fall back to full-mix
      // muting for older songs processed before isolation existed.
      if (song.vocals_url && song.instrumental_url) {
        const vocalsPath = path.join(tmpDir, `bleeep_repr_vocals_${job.song_id}.wav`)
        const instrumentalPath = path.join(tmpDir, `bleeep_repr_instr_${job.song_id}.wav`)
        tmpFiles.push(vocalsPath, instrumentalPath)
        console.log('[pipeline] reprocess: reusing persisted MVSEP stems (vocal-only render)')
        await downloadToFile(song.vocals_url, vocalsPath)
        await downloadToFile(song.instrumental_url, instrumentalPath)
        await renderCleanAudio({ words, outputPath, vocalsPath, instrumentalPath })
      } else {
        if (!originalUrl) throw new Error('reprocess: no stems and no original_url to render from')
        console.log('[pipeline] reprocess: no stems — full-mix render')
        const ext = path.extname(originalFilename) || '.mp3'
        const inputPath = path.join(tmpDir, `bleeep_repr_${job.song_id}${ext}`)
        tmpFiles.push(inputPath)
        await downloadToFile(originalUrl, inputPath)
        await renderCleanAudio({ words, outputPath, inputPath })
      }

      await setJobStatus(job.id, 'uploading')
      resultStoragePath = `clean/${job.user_id}/${job.song_id}_clean.mp3`
      const cleanBuffer = fs.readFileSync(outputPath)
      console.log(`[pipeline] reprocess: uploading clean file (${cleanBuffer.length}B)`)
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(resultStoragePath, cleanBuffer, { contentType: 'audio/mpeg', upsert: true })
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`)
      cleanUrl = publicUrl(resultStoragePath)
      console.log(`[pipeline] reprocess: clean file ${cleanUrl}`)
    }

    await supabase
      .from('songs')
      .update({ clean_url: cleanUrl, words_detected: words, status: 'complete' })
      .eq('id', job.song_id)

    // Contribute the user-confirmed timestamps to the community library.
    if (words.length > 0) {
      try {
        const parsed = parseFilename(originalFilename)
        const fingerprint = trackFingerprint(parsed.artist, parsed.track)
        const { error: tsErr } = await supabase.from('song_timestamps').upsert(
          {
            track_fingerprint: fingerprint,
            timestamps: words,
            source_user_id: job.user_id,
            confidence_score: 1.0,
          },
          { onConflict: 'track_fingerprint,source_user_id' }
        )
        if (tsErr) console.warn('[pipeline] Community timestamp save failed:', tsErr.message)
        else console.log(`[pipeline] Community timestamps saved for "${fingerprint}"`)
      } catch (tsErr) {
        console.warn('[pipeline] Community timestamp save failed:', tsErr)
      }
    }

    await setJobStatus(job.id, 'complete', {
      words_detected: words,
      result_storage_path: resultStoragePath,
    })
    console.log(`[pipeline] reprocess done. job=${job.id} song=${job.song_id} words=${words.length}`)
  } finally {
    cleanupTmp(tmpFiles)
  }
}

function cleanupTmp(tmpFiles: string[]): void {
  try {
    for (const f of tmpFiles) if (fs.existsSync(f)) fs.unlinkSync(f)
  } catch {
    // non-fatal
  }
}
