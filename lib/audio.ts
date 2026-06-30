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
 *
 * Two source modes:
 *  - Vocal-only (preferred): pass `vocalsPath` + `instrumentalPath` (MVSEP
 *    stems). Mute/warp is applied ONLY to the vocal stem, which is then summed
 *    back with the COMPLETELY UNTOUCHED instrumental, so the beat/music plays
 *    through at 100% even during a censored word.
 *  - Full mix (fallback): pass `inputPath`. Mute/warp is applied to the whole
 *    mix (background music is affected during censored words).
 */
export async function renderCleanAudio(opts: {
  words: DetectedWord[]
  outputPath: string
  inputPath?: string
  vocalsPath?: string
  instrumentalPath?: string
}): Promise<void> {
  const { words, outputPath, inputPath, vocalsPath, instrumentalPath } = opts

  const vocalOnly = !!(vocalsPath && instrumentalPath)
  if (!vocalOnly && !inputPath) {
    throw new Error('renderCleanAudio: no input provided')
  }

  const ffmpegPath = getFfmpegPath()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpeg = require('fluent-ffmpeg')
  ffmpeg.setFfmpegPath(ffmpegPath)

  const isWarp = words.length > 0 && words.every((w) => w.mute_type === 'warp')
  console.log(
    `[audio] render mode=${isWarp ? 'WARP' : 'MUTE'} source=${vocalOnly ? 'VOCAL-ONLY' : 'FULL-MIX'} words=${words.length} mute_types=[${words.map((w) => w.mute_type).join(',')}]`
  )

  return new Promise<void>((resolve, reject) => {
    // Vocal-only: input 0 = vocals stem, input 1 = instrumental stem
    // Full-mix:   input 0 = full mix
    const proc = vocalOnly ? ffmpeg(vocalsPath).input(instrumentalPath!) : ffmpeg(inputPath)
    let filterGraph: string

    if (vocalOnly) {
      // Process the vocal stem ([0:a]) into [vproc], then sum with the
      // untouched instrumental ([1:a]). Stems sum back to ~original level, so
      // normalize=0 preserves full loudness and the music is never ducked.
      const vproc = isWarp
        ? buildWarpFilter(words, '0:a', 'vproc')
        : `[0:a]${words
            .map((w) => `volume=enable='between(t,${w.start},${w.end})':volume=0`)
            .join(',')}[vproc]`
      filterGraph = `${vproc};[vproc][1:a]amix=inputs=2:normalize=0[out]`
    } else if (isWarp) {
      filterGraph = buildWarpFilter(words, '0:a', 'out')
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
        console.log(`[audio] ffmpeg render complete (${isWarp ? 'warp' : 'mute'}, ${vocalOnly ? 'vocal-only' : 'full-mix'})`)
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
 * Build the Warp filter graph: split the source into a clean copy and a
 * distorted copy, then crossfade between them so the distorted version is only
 * heard during the detected-word windows.
 *
 *   [in] --> [base]   (original, silenced during word windows)
 *        --> [warp]   (distorted everywhere, gated to only word windows)
 *   amix([base] + [warp]) => [out]
 *
 * `inLabel`/`outLabel` let the same graph run on the full mix ([0:a] -> out)
 * or on just the vocal stem ([0:a] -> vproc) before recombining with the
 * instrumental.
 */
function buildWarpFilter(words: DetectedWord[], inLabel = '0:a', outLabel = 'out'): string {
  // Window expression that is true (1) only inside any detected word region.
  const between = words
    .map((w) => `between(t,${w.start},${w.end})`)
    .join('+')

  // Unique intermediate labels so this can be embedded in a larger graph
  // without colliding with other [base]/[warp] labels.
  const base = `wbase_${outLabel}`
  const warp = `wwarp_${outLabel}`

  const parts: string[] = []

  // 1. Base track: original audio, silenced *inside* the word windows.
  parts.push(`[${inLabel}]volume=enable='${between}':volume=0[${base}]`)

  // 2. Warp track: distort the whole source, then silence everything *outside*
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
    `[${inLabel}]asetrate=44100*0.8,aresample=44100,atempo=1.25,` +
      `lowpass=f=1800,` +
      `vibrato=f=6:d=0.8,tremolo=f=10:d=0.6,` +
      `volume=1.8,` +
      `volume=enable='not(${between})':volume=0[${warp}]`
  )

  // 3. Mix the two gated tracks back into a single stream.
  parts.push(`[${base}][${warp}]amix=inputs=2:normalize=0[${outLabel}]`)

  return parts.join(';')
}

/** Download a remote file to a local path. */
export async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download audio: HTTP ${res.status}`)
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
}
