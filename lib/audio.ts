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
 * Render the clean MP3 with the given words muted or warped.
 *
 * Mute mode: the word's timestamp region goes fully silent.
 *
 * Warp mode: instead of silence, the word region is distorted so the
 * background music stays audible but the word itself is obscured — a
 * low-pass muffle + pitch shift down + a stutter wobble, inspired by the
 * clean-version effect on Kanye's "No Mistakes". The distortion applies
 * ONLY to detected-word regions; the rest of the song is untouched.
 */
export async function renderCleanAudio(opts: {
  words: DetectedWord[]
  outputPath: string
  inputPath?: string
}): Promise<void> {
  const { words, outputPath, inputPath } = opts
  if (!inputPath) throw new Error('renderCleanAudio: no input provided')

  const ffmpegPath = getFfmpegPath()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpeg = require('fluent-ffmpeg')
  ffmpeg.setFfmpegPath(ffmpegPath)

  const isWarp = words.length > 0 && words.every((w) => w.mute_type === 'warp')
  console.log(
    `[audio] render mode=${isWarp ? 'WARP' : 'MUTE'} words=${words.length} mute_types=[${words.map((w) => w.mute_type).join(',')}]`
  )

  return new Promise<void>((resolve, reject) => {
    const proc = ffmpeg(inputPath)
    let filterGraph: string

    if (isWarp) {
      filterGraph = buildWarpFilter(words)
    } else {
      // Mute mode — silence each detected word region on the full mix
      const muteFilter = words
        .map((w) => `volume=enable='between(t,${w.start},${w.end})':volume=0`)
        .join(',')
      filterGraph = `[0:a]${muteFilter}[out]`
    }

    console.log(`[audio] filtergraph: ${filterGraph}`)

    proc
      .complexFilter(filterGraph)
      .outputOptions(['-map [out]', '-c:a libmp3lame', '-b:a 192k'])
      .output(outputPath)
      .on('start', (cmd: string) => {
        console.log(`[audio] ffmpeg command: ${cmd}`)
      })
      .on('end', () => {
        console.log(`[audio] ffmpeg render complete (${isWarp ? 'warp' : 'mute'})`)
        resolve()
      })
      .on('error', (err: Error) => {
        console.error('[audio] ffmpeg error:', err.message)
        reject(new Error(`ffmpeg failed: ${err.message}`))
      })
      .run()
  })
}

/**
 * Build the Warp filter graph: split the mix into a clean copy and a distorted
 * copy, then crossfade between them so the distorted version is only heard
 * during the detected-word windows.
 *
 *   [0:a] --> [base]   (original, silenced during word windows)
 *         --> [warp]   (distorted everywhere, gated to only word windows)
 *   amix([base] + [warp]) => [out]
 */
function buildWarpFilter(words: DetectedWord[]): string {
  // Window expression that is true (1) only inside any detected word region.
  const between = words
    .map((w) => `between(t,${w.start},${w.end})`)
    .join('+')

  const parts: string[] = []

  // 1. Base track: original audio, silenced *inside* the word windows.
  parts.push(`[0:a]volume=enable='${between}':volume=0[base]`)

  // 2. Warp track: distort the whole mix, then silence everything *outside*
  //    the word windows so only the obscured words bleed through during them.
  //    The chain is tuned to stay clearly AUDIBLE (a muffled, pitched-down
  //    wobble) rather than near-silence:
  //    - asetrate*0.8 → pitch down ~3.9 semitones; aresample normalizes the
  //      rate and atempo=1.25 restores the original duration so the distorted
  //      copy stays sample-aligned with the gating windows.
  //    - lowpass f=1800 → muffles the word but keeps it present (300Hz was so
  //      aggressive it sounded like silence on most speakers).
  //    - vibrato + tremolo → the speed wobble / stutter feel (Kanye "No
  //      Mistakes" clean-version vibe).
  //    - volume=1.8 → makeup gain so the muffled word reads at a normal level.
  parts.push(
    `[0:a]asetrate=44100*0.8,aresample=44100,atempo=1.25,` +
      `lowpass=f=1800,` +
      `vibrato=f=6:d=0.8,tremolo=f=10:d=0.6,` +
      `volume=1.8,` +
      `volume=enable='not(${between})':volume=0[warp]`
  )

  // 3. Mix the two gated tracks back into a single stream.
  parts.push(`[base][warp]amix=inputs=2:normalize=0[out]`)

  return parts.join(';')
}

/** Download a remote file to a local path. */
export async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download audio: HTTP ${res.status}`)
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
}
