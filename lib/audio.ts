import fs from 'fs'
import { execSync } from 'child_process'
import type { DetectedWord } from '@/types'

/** Ensure the ffmpeg binary is executable (required in Vercel's Lambda env). */
export function getFfmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegPath: string = require('ffmpeg-static')
  try {
    execSync(`chmod +x "${ffmpegPath}"`, { stdio: 'ignore' })
  } catch {
    // chmod may fail if already executable — that's fine
  }
  return ffmpegPath
}

/**
 * Render the clean MP3 with the given words silenced (or bleeped).
 *
 * Plain mode (`inputPath`): filters apply to the whole mix, so muted
 * sections go fully silent.
 *
 * Stem mode (`vocalsPath` + `instrumentalPath`, from Demucs): filters apply
 * only to the vocal stem, then the untouched instrumental is mixed back in —
 * the beat plays through uninterrupted during muted sections.
 */
export async function renderCleanAudio(opts: {
  words: DetectedWord[]
  outputPath: string
  inputPath?: string
  vocalsPath?: string
  instrumentalPath?: string
}): Promise<void> {
  const { words, outputPath, inputPath, vocalsPath, instrumentalPath } = opts
  const useStems = Boolean(vocalsPath && instrumentalPath)
  const primaryInput = useStems ? vocalsPath! : inputPath
  if (!primaryInput) throw new Error('renderCleanAudio: no input provided')

  const ffmpegPath = getFfmpegPath()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpeg = require('fluent-ffmpeg')
  ffmpeg.setFfmpegPath(ffmpegPath)

  const isBleep = words.length > 0 && words.every((w) => w.mute_type === 'bleep')

  const muteFilter = words
    .map((w) => `volume=enable='between(t,${w.start},${w.end})':volume=0`)
    .join(',')

  return new Promise<void>((resolve, reject) => {
    const proc = ffmpeg(primaryInput)
    if (useStems) proc.input(instrumentalPath!)

    // [0:a] = vocals (stem mode) or full mix (plain mode), with words silenced
    const filters: string[] = [`[0:a]${muteFilter}[silenced]`]
    const mixInputs: string[] = ['[silenced]']
    if (useStems) mixInputs.push('[1:a]')

    if (isBleep) {
      // Overlay a 1kHz tone over each silenced word
      words.forEach((w, i) => {
        const dur = Math.max(0.05, w.end - w.start)
        filters.push(
          `sine=frequency=1000:duration=${dur}[beep${i}raw]`,
          `[beep${i}raw]adelay=${Math.round(w.start * 1000)}|${Math.round(w.start * 1000)}[bleep${i}]`
        )
        mixInputs.push(`[bleep${i}]`)
      })
    }

    if (mixInputs.length > 1) {
      filters.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:normalize=0[out]`)
    } else {
      // Mute-only on a single input — no mixing needed
      filters[0] = `[0:a]${muteFilter}[out]`
    }

    proc
      .complexFilter(filters.join(';'))
      .outputOptions(['-map [out]', '-c:a libmp3lame', '-b:a 192k'])
      .output(outputPath)
      .on('end', () => {
        console.log(`[audio] ffmpeg render complete (${useStems ? 'stems' : 'plain'}, ${isBleep ? 'bleep' : 'mute'})`)
        resolve()
      })
      .on('error', (err: Error) => {
        console.error('[audio] ffmpeg error:', err.message)
        reject(new Error(`ffmpeg failed: ${err.message}`))
      })
      .run()
  })
}

/** Download a remote file to a local path. */
export async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download audio: HTTP ${res.status}`)
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
}
