import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import path from 'path'
import os from 'os'
import fs from 'fs'
import type { DetectedWord } from '@/types'
import { parseFilename } from '@/lib/lrclib'
import { trackFingerprint } from '@/lib/fingerprint'
import { renderCleanAudio, downloadToFile } from '@/lib/audio'

export const maxDuration = 300

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
    const tmpFiles: string[] = []

    if (wordsDetected.length > 0) {
      const tmpDir = os.tmpdir()
      const outputPath = path.join(tmpDir, `bleeep_repr_out_${songId}.mp3`)
      tmpFiles.push(outputPath)

      console.log('[reprocess] ffmpeg windows:', wordsDetected.map((w) => `${w.start}–${w.end}s`).join(', '))

      const ext = path.extname(originalFilename) || '.mp3'
      const inputPath = path.join(tmpDir, `bleeep_repr_${songId}${ext}`)
      tmpFiles.push(inputPath)
      console.log(`[reprocess] Downloading audio: ${originalUrl}`)
      await downloadToFile(originalUrl, inputPath)

      await renderCleanAudio({
        words: wordsDetected,
        outputPath,
        inputPath,
      })

      // Upload — upsert:true since a clean file may already exist from the initial process run
      const cleanStoragePath = `clean/${user.id}/${songId}_clean.mp3`
      const cleanBuffer = fs.readFileSync(outputPath)
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

    // Contribute the user-confirmed timestamps to the community library.
    // Upsert: re-finalizing the same track replaces this user's entry.
    if (wordsDetected.length > 0) {
      try {
        const parsed = parseFilename(originalFilename)
        const fingerprint = trackFingerprint(parsed.artist, parsed.track)
        const { error: tsErr } = await adminSupabase
          .from('song_timestamps')
          .upsert(
            {
              track_fingerprint: fingerprint,
              timestamps: wordsDetected,
              source_user_id: user.id,
              confidence_score: 1.0,
            },
            { onConflict: 'track_fingerprint,source_user_id' }
          )
        if (tsErr) console.warn('[reprocess] Community timestamp save failed:', tsErr.message)
        else console.log(`[reprocess] Community timestamps saved for "${fingerprint}"`)
      } catch (tsErr) {
        console.warn('[reprocess] Community timestamp save failed:', tsErr)
      }
    }

    try {
      for (const f of tmpFiles) if (fs.existsSync(f)) fs.unlinkSync(f)
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
