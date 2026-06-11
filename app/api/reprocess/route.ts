import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { execSync } from 'child_process'
import type { DetectedWord } from '@/types'

export const maxDuration = 300

function getFfmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegPath: string = require('ffmpeg-static')
  try {
    execSync(`chmod +x "${ffmpegPath}"`, { stdio: 'ignore' })
  } catch {
    // already executable
  }
  return ffmpegPath
}

export async function POST(request: NextRequest) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  const supabase = await createClient()
  const adminSupabase = createAdminClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: {
    songId: string
    originalUrl: string
    originalFilename: string
    wordsDetected: DetectedWord[]
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { songId, originalUrl, originalFilename, wordsDetected = [] } = body

  if (!songId || !originalUrl || !originalFilename) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  // Verify the song belongs to this user
  const { data: song } = await adminSupabase
    .from('songs')
    .select('id')
    .eq('id', songId)
    .eq('user_id', user.id)
    .single()

  if (!song) return NextResponse.json({ error: 'Song not found' }, { status: 404 })

  console.log(`[reprocess] Received ${wordsDetected.length} word(s):`, JSON.stringify(wordsDetected))

  try {
    let cleanUrl = originalUrl
    let inputPath: string | undefined
    let outputPath: string | undefined

    if (wordsDetected.length > 0) {
      const tmpDir = os.tmpdir()
      const ext = path.extname(originalFilename) || '.mp3'
      inputPath = path.join(tmpDir, `bleeep_repr_${songId}${ext}`)
      outputPath = path.join(tmpDir, `bleeep_repr_out_${songId}.mp3`)

      console.log(`[reprocess] Downloading audio: ${originalUrl}`)
      const audioRes = await fetch(originalUrl)
      if (!audioRes.ok) throw new Error(`Failed to download audio: HTTP ${audioRes.status}`)
      fs.writeFileSync(inputPath, Buffer.from(await audioRes.arrayBuffer()))

      const ffmpegPath = getFfmpegPath()
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ffmpeg = require('fluent-ffmpeg')
      ffmpeg.setFfmpegPath(ffmpegPath)

      const localInput = inputPath
      const localOutput = outputPath

      console.log('[reprocess] ffmpeg mute windows:', wordsDetected.map((w) => `${w.start}–${w.end}s`).join(', '))

      await new Promise<void>((resolve, reject) => {
        const proc = ffmpeg(localInput)
        const isBleep = wordsDetected.every((w) => w.mute_type === 'bleep')

        if (isBleep) {
          const muteFilter = wordsDetected
            .map((w) => `volume=enable='between(t,${w.start},${w.end})':volume=0`)
            .join(',')

          const bleepFilters: string[] = []
          const bleepLabels: string[] = []
          wordsDetected.forEach((w, i) => {
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
            .output(localOutput)
            .on('end', () => { console.log('[reprocess] bleep done'); resolve() })
            .on('error', (err: Error) => reject(new Error(`ffmpeg failed: ${err.message}`)))
            .run()
        } else {
          const muteFilter = wordsDetected
            .map((w) => `volume=enable='between(t,${w.start},${w.end})':volume=0`)
            .join(',')

          proc
            .audioFilters(muteFilter)
            .audioCodec('libmp3lame')
            .audioBitrate('192k')
            .output(localOutput)
            .on('end', () => { console.log('[reprocess] mute done'); resolve() })
            .on('error', (err: Error) => reject(new Error(`ffmpeg failed: ${err.message}`)))
            .run()
        }
      })

      // Upload — upsert:true since a clean file may already exist from the initial process run
      const cleanStoragePath = `clean/${user.id}/${songId}_clean.mp3`
      const cleanBuffer = fs.readFileSync(localOutput)
      console.log(`[reprocess] Uploading clean file (${cleanBuffer.length} bytes)`)

      const { error: uploadErr } = await adminSupabase.storage
        .from('audio')
        .upload(cleanStoragePath, cleanBuffer, { contentType: 'audio/mpeg', upsert: true })

      if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)

      const { data: urlData } = adminSupabase.storage.from('audio').getPublicUrl(cleanStoragePath)
      cleanUrl = urlData.publicUrl
      console.log(`[reprocess] Clean file: ${cleanUrl}`)
    }

    // Update the existing song record
    await adminSupabase
      .from('songs')
      .update({ clean_url: cleanUrl, words_detected: wordsDetected, status: 'complete' })
      .eq('id', songId)

    try {
      if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath)
      if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    } catch {
      // non-fatal
    }

    console.log(`[reprocess] Done. songId=${songId} words=${wordsDetected.length}`)
    return NextResponse.json({ success: true, songId, cleanUrl, wordsDetected })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Reprocessing failed'
    console.error(`[reprocess] FAILED songId=${songId}:`, err)
    await adminSupabase.from('songs').update({ status: 'failed' }).eq('id', songId)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
