import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { isProfane, WORD_BOOST } from '@/lib/profanity-list'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import os from 'os'
import fs from 'fs'
import type { DetectedWord } from '@/types'

// Increase body size limit for this route
export const maxDuration = 300 // 5 min timeout on Vercel Pro

// ── helpers ─────────────────────────────────────────────────────────────────

async function pollAssemblyAI(transcriptId: string, apiKey: string) {
  const maxAttempts = 120
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const res = await fetch(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { headers: { authorization: apiKey } }
    )
    const data = await res.json()
    if (data.status === 'completed') return data
    if (data.status === 'error') throw new Error(`AssemblyAI error: ${data.error}`)
  }
  throw new Error('AssemblyAI transcription timed out')
}

// ── main handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const adminSupabase = createAdminClient()

  // 1. Auth check
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Check plan / usage limits
  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  const FREE_LIMIT = 3
  if (profile.plan === 'free' && profile.songs_processed_this_month >= FREE_LIMIT) {
    return NextResponse.json(
      {
        error: 'Monthly limit reached',
        message: `You've used all ${FREE_LIMIT} free songs this month. Upgrade to Pro for unlimited songs.`,
        upgrade: true,
      },
      { status: 429 }
    )
  }

  // 3. Parse the form data
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  const muteType = (formData.get('muteType') as string) || 'mute'

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/mp3']
  if (!allowedTypes.includes(file.type) && !file.name.match(/\.(mp3|wav)$/i)) {
    return NextResponse.json(
      { error: 'Invalid file type. Only MP3 and WAV are supported.' },
      { status: 400 }
    )
  }

  const MAX_SIZE = 50 * 1024 * 1024 // 50MB
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: 'File too large. Maximum size is 50MB.' },
      { status: 400 }
    )
  }

  // 4. Create song record in DB with 'processing' status
  const songId = uuidv4()
  await adminSupabase.from('songs').insert({
    id: songId,
    user_id: user.id,
    original_filename: file.name,
    status: 'processing',
    words_detected: [],
  })

  try {
    // 5. Write file to temp disk
    const tmpDir = os.tmpdir()
    const ext = path.extname(file.name) || '.mp3'
    const inputPath = path.join(tmpDir, `bleeep_input_${songId}${ext}`)
    const outputPath = path.join(tmpDir, `bleeep_output_${songId}.mp3`)

    const arrayBuffer = await file.arrayBuffer()
    fs.writeFileSync(inputPath, Buffer.from(arrayBuffer))

    // 6. Upload original to Supabase Storage
    const originalStoragePath = `originals/${user.id}/${songId}${ext}`
    const { error: uploadErr } = await adminSupabase.storage
      .from('audio')
      .upload(originalStoragePath, fs.readFileSync(inputPath), {
        contentType: file.type || 'audio/mpeg',
        upsert: false,
      })

    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`)

    const { data: originalUrlData } = adminSupabase.storage
      .from('audio')
      .getPublicUrl(originalStoragePath)

    const originalUrl = originalUrlData.publicUrl

    // Update DB with original URL
    await adminSupabase
      .from('songs')
      .update({ original_url: originalUrl })
      .eq('id', songId)

    // 7. Send to AssemblyAI
    const assemblyApiKey = process.env.ASSEMBLYAI_API_KEY!

    const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        authorization: assemblyApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: originalUrl,
        speech_model: 'best',
        filter_profanity: false,
        word_boost: WORD_BOOST,
        boost_param: 'high',
      }),
    })

    if (!submitRes.ok) {
      const err = await submitRes.text()
      throw new Error(`AssemblyAI submit failed: ${err}`)
    }

    const { id: transcriptId } = await submitRes.json()

    // 8. Poll until complete
    const transcript = await pollAssemblyAI(transcriptId, assemblyApiKey)

    // 9. Extract profane words with timestamps
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

    // 10. Process audio with ffmpeg
    let cleanUrl = originalUrl // fallback if no words detected

    if (detectedWords.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ffmpeg = require('fluent-ffmpeg')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ffmpegPath = require('ffmpeg-static')
      ffmpeg.setFfmpegPath(ffmpegPath)

      // Use direct ffmpeg spawn for complex filter_complex
      await new Promise<void>((resolve, reject) => {
        const proc = ffmpeg(inputPath)
        const isMute = detectedWords.every((w) => w.mute_type === 'mute')
        const isBleep = detectedWords.every((w) => w.mute_type === 'bleep')

        if (isMute) {
          // Build volume filter for mute
          const muteFilter = detectedWords
            .map((w) => `volume=enable='between(t,${w.start},${w.end})':volume=0`)
            .join(',')
          proc
            .audioFilters(muteFilter)
            .audioCodec('libmp3lame')
            .audioBitrate('192k')
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run()
        } else if (isBleep) {
          // For bleep, build filter_complex
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
            .on('end', resolve)
            .on('error', reject)
            .run()
        } else {
          // Mixed — treat all as mute for simplicity
          const muteFilter = detectedWords
            .map((w) => `volume=enable='between(t,${w.start},${w.end})':volume=0`)
            .join(',')
          proc
            .audioFilters(muteFilter)
            .audioCodec('libmp3lame')
            .audioBitrate('192k')
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run()
        }
      })

      // 11. Upload clean file to Supabase
      const cleanStoragePath = `clean/${user.id}/${songId}_clean.mp3`
      const cleanBuffer = fs.readFileSync(outputPath)

      const { error: cleanUploadErr } = await adminSupabase.storage
        .from('audio')
        .upload(cleanStoragePath, cleanBuffer, {
          contentType: 'audio/mpeg',
          upsert: false,
        })

      if (cleanUploadErr) throw new Error(`Clean upload failed: ${cleanUploadErr.message}`)

      const { data: cleanUrlData } = adminSupabase.storage
        .from('audio')
        .getPublicUrl(cleanStoragePath)

      cleanUrl = cleanUrlData.publicUrl
    }

    // 12. Save final record
    await adminSupabase.from('songs').update({
      original_url: originalUrl,
      clean_url: cleanUrl,
      words_detected: detectedWords,
      status: 'complete',
    }).eq('id', songId)

    // 13. Increment usage counter
    await adminSupabase
      .from('profiles')
      .update({
        songs_processed_this_month: profile.songs_processed_this_month + 1,
      })
      .eq('id', user.id)

    // Clean up temp files
    try {
      fs.unlinkSync(inputPath)
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    } catch {}

    return NextResponse.json({
      success: true,
      songId,
      cleanUrl,
      originalUrl,
      wordsDetected: detectedWords,
      wordCount: detectedWords.length,
    })
  } catch (err) {
    console.error('[/api/process] error:', err)

    // Mark job as failed
    await adminSupabase
      .from('songs')
      .update({ status: 'failed' })
      .eq('id', songId)

    const message = err instanceof Error ? err.message : 'Processing failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
