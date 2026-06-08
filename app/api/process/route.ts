import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { isProfane, WORD_BOOST } from '@/lib/profanity-list'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { execSync } from 'child_process'
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

// Ensure the ffmpeg binary is executable (required in Vercel's Lambda env)
function getFfmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegPath: string = require('ffmpeg-static')
  try {
    execSync(`chmod +x "${ffmpegPath}"`, { stdio: 'ignore' })
  } catch {
    // chmod may fail if already executable — that's fine
  }
  return ffmpegPath
}

// ── main handler ──────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Guard: catch missing env vars early with a clear message
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[process] FATAL: SUPABASE_SERVICE_ROLE_KEY is not set')
    return NextResponse.json({ error: 'Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY' }, { status: 500 })
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
    // PGRST116 = "no rows found" — anything else is a real DB/auth error
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

  // 3. Parse JSON body — the file was already uploaded to Supabase by the browser
  let body: {
    songId: string
    originalUrl: string
    originalFilename: string
    muteType: string
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

  // 4. Create song record in DB
  await adminSupabase.from('songs').insert({
    id: songId,
    user_id: user.id,
    original_filename: originalFilename,
    original_url: originalUrl,
    status: 'processing',
    words_detected: [],
  })

  try {
    // 5. Download the audio file from Supabase to /tmp for ffmpeg
    const tmpDir = os.tmpdir()
    const ext = path.extname(originalFilename) || '.mp3'
    const inputPath = path.join(tmpDir, `bleeep_input_${songId}${ext}`)
    const outputPath = path.join(tmpDir, `bleeep_output_${songId}.mp3`)

    console.log(`[process] Downloading audio from Supabase: ${originalUrl}`)
    const audioRes = await fetch(originalUrl)
    if (!audioRes.ok) {
      throw new Error(`Failed to download audio file: HTTP ${audioRes.status}`)
    }
    const audioBuffer = await audioRes.arrayBuffer()
    fs.writeFileSync(inputPath, Buffer.from(audioBuffer))
    console.log(`[process] Audio saved to ${inputPath} (${audioBuffer.byteLength} bytes)`)

    // 6. Send to AssemblyAI for transcription
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

    // 7. Poll until transcription is complete
    const transcript = await pollAssemblyAI(transcriptId, assemblyApiKey)
    console.log(`[process] Transcription complete. Words: ${transcript.words?.length ?? 0}`)

    // 8. Extract profane words with timestamps
    const rawWords: Array<{ text: string; start: number; end: number }> =
      transcript.words || []

    const detectedWords: DetectedWord[] = rawWords
      .filter((w) => isProfane(w.text))
      .map((w) => ({
        word: w.text,
        start: w.start / 1000, // ms → seconds
        end: w.end / 1000,
        mute_type: muteType as 'mute' | 'bleep',
      }))

    console.log(`[process] Profane words detected: ${detectedWords.length}`)

    // 9. Process audio with ffmpeg
    let cleanUrl = originalUrl // fallback: no words found = original is already clean

    if (detectedWords.length > 0) {
      const ffmpegPath = getFfmpegPath()
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ffmpeg = require('fluent-ffmpeg')
      ffmpeg.setFfmpegPath(ffmpegPath)
      console.log(`[process] Running ffmpeg at: ${ffmpegPath}`)

      await new Promise<void>((resolve, reject) => {
        const proc = ffmpeg(inputPath)
        const isBleep = detectedWords.every((w) => w.mute_type === 'bleep')

        if (isBleep) {
          // Bleep: silence the word AND overlay a 1kHz tone
          const muteFilter = detectedWords
            .map((w) => `volume=enable='between(t,${w.start},${w.end})':volume=0`)
            .join(',')

          const bleepFilters: string[] = []
          const bleepLabels: string[] = []
          detectedWords.forEach((w, i) => {
            const dur = Math.max(0.05, w.end - w.start)
            bleepFilters.push(
              `sine=frequency=1000:duration=${dur}[beep${i}raw]`,
              `[beep${i}raw]adelay=${Math.round(w.start * 1000)}|${Math.round(w.start * 1000)}[bleep${i}]`
            )
            bleepLabels.push(`[bleep${i}]`)
          })

          const allInputs = ['[silenced]', ...bleepLabels]
          const complexFilter = [
            `[0:a]${muteFilter}[silenced]`,
            ...bleepFilters,
            `${allInputs.join('')}amix=inputs=${allInputs.length}:normalize=0[out]`,
          ].join(';')

          proc
            .complexFilter(complexFilter)
            .outputOptions(['-map [out]', '-c:a libmp3lame', '-b:a 192k'])
            .output(outputPath)
            .on('end', () => {
              console.log('[process] ffmpeg bleep processing complete')
              resolve()
            })
            .on('error', (err: Error) => {
              console.error('[process] ffmpeg error:', err.message)
              reject(new Error(`ffmpeg failed: ${err.message}`))
            })
            .run()
        } else {
          // Mute: silence the word segments
          const muteFilter = detectedWords
            .map((w) => `volume=enable='between(t,${w.start},${w.end})':volume=0`)
            .join(',')

          proc
            .audioFilters(muteFilter)
            .audioCodec('libmp3lame')
            .audioBitrate('192k')
            .output(outputPath)
            .on('end', () => {
              console.log('[process] ffmpeg mute processing complete')
              resolve()
            })
            .on('error', (err: Error) => {
              console.error('[process] ffmpeg error:', err.message)
              reject(new Error(`ffmpeg failed: ${err.message}`))
            })
            .run()
        }
      })

      // 10. Upload clean file to Supabase
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

    // 11. Save final record to DB
    await adminSupabase
      .from('songs')
      .update({
        clean_url: cleanUrl,
        words_detected: detectedWords,
        status: 'complete',
      })
      .eq('id', songId)

    // 12. Increment usage counter
    await adminSupabase
      .from('profiles')
      .update({
        songs_processed_this_month: profile.songs_processed_this_month + 1,
      })
      .eq('id', user.id)

    // Clean up temp files
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath)
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    } catch {
      // Non-fatal — /tmp is cleared between invocations anyway
    }

    console.log(`[process] Done. songId=${songId} wordCount=${detectedWords.length}`)

    return NextResponse.json({
      success: true,
      songId,
      cleanUrl,
      originalUrl,
      wordsDetected: detectedWords,
      wordCount: detectedWords.length,
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
