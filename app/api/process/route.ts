import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { isProfane, WORD_BOOST } from '@/lib/profanity-list'
import { parseFilename, fetchLrcLyrics, parseLrc, detectProfanityInLyrics } from '@/lib/lrclib'
import { trackFingerprint } from '@/lib/fingerprint'
import { renderCleanAudio, downloadToFile } from '@/lib/audio'
import path from 'path'
import os from 'os'
import fs from 'fs'
import type { DetectedWord } from '@/types'

export const maxDuration = 300 // requires Vercel Pro; Hobby plan caps at 60s

// ── helpers ───────────────────────────────────────────────────────────────────

async function pollAssemblyAI(transcriptId: string, apiKey: string) {
  const maxAttempts = 100 // ~5 min at 3s intervals
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const res = await fetch(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { headers: { authorization: apiKey } }
    )
    if (!res.ok) throw new Error(`AssemblyAI poll failed: ${res.status}`)
    const data = await res.json()
    if (data.status === 'completed') return data
    if (data.status === 'error') throw new Error(`AssemblyAI error: ${data.error}`)
  }
  throw new Error('AssemblyAI transcription timed out after 5 minutes')
}

// ── main handler ──────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Guard: catch missing env vars early with a clear message
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[process] FATAL: SUPABASE_SERVICE_ROLE_KEY is not set')
    return NextResponse.json(
      { error: 'Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY' },
      { status: 500 }
    )
  }

  const supabase = await createClient()
  const adminSupabase = createAdminClient()

  // 1. Auth check
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Fetch profile — auto-create if missing (handles accounts that
  //    signed up before the on_auth_user_created trigger was deployed)
  const { data: profile0, error: selectErr } = await adminSupabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (selectErr && selectErr.code !== 'PGRST116') {
    console.error('[process] Profile SELECT error:', selectErr.code, selectErr.message, selectErr.details)
    return NextResponse.json(
      { error: `Profile lookup failed: ${selectErr.message} (code: ${selectErr.code})` },
      { status: 500 }
    )
  }

  let profile = profile0

  if (!profile) {
    console.log(`[process] No profile for user ${user.id} (${user.email}), auto-creating...`)
    const { data: newProfile, error: insertErr } = await adminSupabase
      .from('profiles')
      .insert({ id: user.id, email: user.email ?? '', plan: 'free', songs_processed_this_month: 0 })
      .select()
      .single()

    if (insertErr || !newProfile) {
      console.error('[process] Profile INSERT failed:', insertErr?.code, insertErr?.message, insertErr?.details, insertErr?.hint)
      return NextResponse.json(
        { error: `Could not create user profile: ${insertErr?.message ?? 'unknown'} (code: ${insertErr?.code ?? 'none'})` },
        { status: 500 }
      )
    }
    console.log(`[process] Profile auto-created for user ${user.id}`)
    profile = newProfile
  }

  // 3. Check plan / usage limits
  const FREE_LIMIT = 3
  if (profile.plan === 'free' && profile.songs_processed_this_month >= FREE_LIMIT) {
    return NextResponse.json(
      {
        error: 'Monthly limit reached',
        message: `You've used all ${FREE_LIMIT} free songs this month.`,
        upgrade: true,
      },
      { status: 429 }
    )
  }

  // 4. Parse JSON body — the file was already uploaded to Supabase by the browser
  let body: {
    songId: string
    originalUrl: string
    originalFilename: string
    muteType: string
    manualLyrics?: string
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { songId, originalUrl, originalFilename, muteType = 'mute' } = body

  if (!songId || !originalUrl || !originalFilename) {
    return NextResponse.json(
      { error: 'Missing required fields: songId, originalUrl, originalFilename' },
      { status: 400 }
    )
  }

  // 5. Create song record in DB
  await adminSupabase.from('songs').insert({
    id: songId,
    user_id: user.id,
    original_filename: originalFilename,
    original_url: originalUrl,
    status: 'processing',
    words_detected: [],
  })

  try {
    // ── Step 6: Detect profanity (manual lyrics → community → LRCLIB → AssemblyAI) ──
    let detectedWords: DetectedWord[] = []
    let detectionMethod: 'lyrics' | 'ai' | 'community' = 'ai'

    // 6a. Manual lyrics pasted by the user — highest priority
    const manualLyrics = body.manualLyrics
    if (manualLyrics && manualLyrics.trim()) {
      const lines = parseLrc(manualLyrics)
      if (lines.length > 0) {
        detectedWords = detectProfanityInLyrics(lines, muteType as 'mute' | 'warp')
        detectionMethod = 'lyrics'
        console.log(`[process] Manual LRC: ${lines.length} lines, ${detectedWords.length} profane`)
      } else {
        console.log('[process] Manual lyrics provided but no LRC timestamps found — falling through')
      }
    }

    const parsed = parseFilename(originalFilename)
    console.log(`[process] Filename → artist="${parsed.artist}" track="${parsed.track}"`)

    // 6b. Community timestamp library — timestamps confirmed by 2+ other users
    //     let us skip LRCLIB/AssemblyAI entirely
    if (detectionMethod === 'ai') try {
      const fingerprint = trackFingerprint(parsed.artist, parsed.track)
      const { data: communityRows, error: communityErr } = await adminSupabase
        .from('song_timestamps')
        .select('timestamps, confidence_score, created_at')
        .eq('track_fingerprint', fingerprint)
        .order('confidence_score', { ascending: false })
        .order('created_at', { ascending: false })

      if (communityErr) {
        console.warn('[process] Community lookup failed:', communityErr.message)
      } else if (communityRows && communityRows.length >= 2) {
        const saved = (communityRows[0].timestamps ?? []) as DetectedWord[]
        detectedWords = saved.map((w) => ({
          ...w,
          mute_type: muteType as 'mute' | 'warp',
        }))
        detectionMethod = 'community'
        console.log(
          `[process] Community match: ${communityRows.length} confirmations for "${fingerprint}" → ${detectedWords.length} word(s)`
        )
      } else {
        console.log(
          `[process] Community: ${communityRows?.length ?? 0} match(es) for "${fingerprint}" — need 2+, continuing`
        )
      }
    } catch (communityErr) {
      console.warn('[process] Community lookup failed:', communityErr)
    }

    // 6c. LRCLIB (if no manual lyrics or community match)
    if (detectionMethod === 'ai') try {
      const lrcText = await fetchLrcLyrics(parsed.artist, parsed.track)
      if (lrcText) {
        const lines = parseLrc(lrcText)
        detectedWords = detectProfanityInLyrics(lines, muteType as 'mute' | 'warp')
        detectionMethod = 'lyrics'
        console.log(`[process] Lyrics route: ${lines.length} lines, ${detectedWords.length} profane found`)
      } else {
        console.log('[process] No synced lyrics on LRCLIB — falling back to AssemblyAI')
      }
    } catch (lrcErr) {
      console.warn('[process] LRCLIB failed — falling back to AssemblyAI:', lrcErr)
    }

    // ── Step 7: AssemblyAI fallback (if neither manual lyrics nor LRCLIB matched) ──
    if (detectionMethod === 'ai') {
      const assemblyApiKey = process.env.ASSEMBLYAI_API_KEY
      if (!assemblyApiKey) throw new Error('ASSEMBLYAI_API_KEY is not set')

      console.log('[process] Submitting to AssemblyAI...')
      const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: {
          authorization: assemblyApiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          audio_url: originalUrl,
          speech_models: ['universal-3-pro'],
          filter_profanity: false,
          keyterms_prompt: WORD_BOOST,
        }),
      })

      if (!submitRes.ok) {
        const errText = await submitRes.text()
        throw new Error(`AssemblyAI submit failed (${submitRes.status}): ${errText}`)
      }

      const { id: transcriptId } = await submitRes.json()
      console.log(`[process] AssemblyAI transcript ID: ${transcriptId}`)

      const transcript = await pollAssemblyAI(transcriptId, assemblyApiKey)
      console.log(`[process] Transcription complete. Words: ${transcript.words?.length ?? 0}`)

      const rawWords: Array<{ text: string; start: number; end: number }> =
        transcript.words || []

      detectedWords = rawWords
        .filter((w) => isProfane(w.text))
        .map((w) => ({
          word: w.text,
          start: w.start / 1000, // ms → seconds
          end: w.end / 1000,
          mute_type: muteType as 'mute' | 'warp',
        }))
    }

    console.log(`[process] Detection (${detectionMethod}) found ${detectedWords.length} profane word(s)`)

    // ── Step 8: Process audio with ffmpeg (only if profanity was found) ───────
    let cleanUrl = originalUrl
    const tmpFiles: string[] = []

    if (detectedWords.length > 0) {
      const tmpDir = os.tmpdir()
      const outputPath = path.join(tmpDir, `bleeep_output_${songId}.mp3`)
      tmpFiles.push(outputPath)

      // 8a. Download the full mix to /tmp
      const ext = path.extname(originalFilename) || '.mp3'
      const inputPath = path.join(tmpDir, `bleeep_input_${songId}${ext}`)
      tmpFiles.push(inputPath)
      console.log(`[process] Downloading audio for ffmpeg: ${originalUrl}`)
      await downloadToFile(originalUrl, inputPath)

      // 8b. Render: mute or warp the detected words
      await renderCleanAudio({
        words: detectedWords,
        outputPath,
        inputPath,
      })

      // Upload clean file to Supabase
      const cleanStoragePath = `clean/${user.id}/${songId}_clean.mp3`
      const cleanBuffer = fs.readFileSync(outputPath)
      console.log(`[process] Uploading clean file (${cleanBuffer.length} bytes)`)

      const { error: cleanUploadErr } = await adminSupabase.storage
        .from('audio')
        .upload(cleanStoragePath, cleanBuffer, {
          contentType: 'audio/mpeg',
          upsert: false,
        })

      if (cleanUploadErr) throw new Error(`Clean file upload failed: ${cleanUploadErr.message}`)

      const { data: cleanUrlData } = adminSupabase.storage
        .from('audio')
        .getPublicUrl(cleanStoragePath)

      cleanUrl = cleanUrlData.publicUrl
      console.log(`[process] Clean file uploaded: ${cleanUrl}`)
    }

    // ── Step 9: Save final record to DB ──────────────────────────────────────
    await adminSupabase
      .from('songs')
      .update({
        clean_url: cleanUrl,
        words_detected: detectedWords,
        status: 'complete',
      })
      .eq('id', songId)

    // ── Step 10: Increment usage counter ─────────────────────────────────────
    await adminSupabase
      .from('profiles')
      .update({
        songs_processed_this_month: profile.songs_processed_this_month + 1,
      })
      .eq('id', user.id)

    // Clean up temp files
    try {
      for (const f of tmpFiles) if (fs.existsSync(f)) fs.unlinkSync(f)
    } catch {
      // Non-fatal — /tmp is cleared between invocations anyway
    }

    console.log(`[process] Done. songId=${songId} method=${detectionMethod} words=${detectedWords.length}`)

    return NextResponse.json({
      success: true,
      songId,
      cleanUrl,
      originalUrl,
      wordsDetected: detectedWords,
      wordCount: detectedWords.length,
      detectionMethod,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Processing failed'
    console.error(`[process] FAILED songId=${songId}:`, err)

    await adminSupabase
      .from('songs')
      .update({ status: 'failed' })
      .eq('id', songId)

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
