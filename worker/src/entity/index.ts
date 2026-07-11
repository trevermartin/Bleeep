/**
 * The Entity — bleeep's autonomous censorship intelligence.
 *
 * One call, `censorAndVerify`, runs the full closed loop:
 *
 *   render → measure every censored window → if any window leaks voice,
 *   widen it and render again → repeat until every window is provably clean
 *   (or the attempt budget is spent, in which case the report says so).
 *
 * The instrumental stem is never processed — only the vocal bus is censored
 * and then summed back with the untouched music.
 */

import path from 'path'
import fs from 'fs'
import type { DetectedWord, VerificationReport } from '../types'
import { renderCleanAudio, type RenderWindow } from '../services/audio'
import { verifyRender } from './verify'
import { extractEnvelope, snapWordsToValleys } from './envelope'

export { detectContent, matchToken, tokenCandidates, type Detection } from './detect'
export {
  PROFILES,
  WORD_BOOST,
  CATEGORY_LABELS,
  type CensorProfile,
  type ContentCategory,
} from './lexicon'
export { verifyRender, measureWindowDb, MUTE_THRESHOLD_DB } from './verify'
export { extractEnvelope, snapWordsToValleys, type EnvelopeFrame } from './envelope'

/** How much each failed window grows per retry (seconds, each side). */
const WIDEN_STEP_SEC = 0.08
const MAX_ATTEMPTS = 3

export interface CensorAndVerifyOptions {
  words: DetectedWord[]
  outputPath: string
  /** Full-mix fallback source. */
  inputPath?: string
  /** Stem mode: censor vocals only, keep instrumental 100% intact. */
  vocalsPath?: string
  instrumentalPath?: string
  /** Directory for the temporary verification bus WAVs. */
  workDir: string
  /** Unique tag for temp filenames (e.g. the song id). */
  tag: string
  maxAttempts?: number
  /**
   * Snap each window's boundaries to the vocal stem's energy valleys before
   * the first render (fixes ASR timestamp drift). Enable for fresh AI
   * detections; leave off for user-confirmed timings.
   */
  snapToVocalEnergy?: boolean
}

export interface CensorAndVerifyResult {
  /** Final word list (windows may have been widened by the retry loop). */
  words: DetectedWord[]
  report: VerificationReport
  windows: RenderWindow[]
}

/** Widen every word that overlaps a failed window by `sec` on each side. */
function widenFailures(
  words: DetectedWord[],
  failed: Array<{ start: number; end: number }>,
  sec: number
): DetectedWord[] {
  return words.map((w) => {
    const hit = failed.some((f) => w.start < f.end && w.end > f.start)
    if (!hit) return w
    return {
      ...w,
      start: Math.max(0, +(w.start - sec).toFixed(3)),
      end: +(w.end + sec).toFixed(3),
    }
  })
}

export async function censorAndVerify(
  opts: CensorAndVerifyOptions
): Promise<CensorAndVerifyResult> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS
  const originalVocalsPath = opts.vocalsPath ?? opts.inputPath
  if (!originalVocalsPath) throw new Error('censorAndVerify: no audio source provided')

  let words = opts.words
  let windows: RenderWindow[] = []
  let report: VerificationReport | null = null
  const busFiles: string[] = []

  // Boundary snapping: align every window to the natural silences around the
  // word in the actual vocal audio, instead of trusting ASR timing blindly.
  if (opts.snapToVocalEnergy) {
    try {
      const env = await extractEnvelope(originalVocalsPath)
      const snapped = snapWordsToValleys(words, env)
      const moved = snapped.filter(
        (w, i) => w.start !== words[i].start || w.end !== words[i].end
      ).length
      console.log(`[entity] boundary snap: ${moved}/${words.length} windows aligned to energy valleys`)
      words = snapped
    } catch (err) {
      console.warn('[entity] boundary snap skipped:', err instanceof Error ? err.message : err)
    }
  }

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const vocalBusPath = path.join(opts.workDir, `entity_bus_${opts.tag}_${attempt}.wav`)
      busFiles.push(vocalBusPath)

      windows = await renderCleanAudio({
        words,
        outputPath: opts.outputPath,
        inputPath: opts.inputPath,
        vocalsPath: opts.vocalsPath,
        instrumentalPath: opts.instrumentalPath,
        vocalBusPath,
      })

      report = await verifyRender({
        vocalBusPath,
        originalVocalsPath,
        windows,
        attempt,
      })

      const failed = report.windows.filter((w) => !w.pass)
      console.log(
        `[entity] verification attempt ${attempt}/${maxAttempts}: ` +
          `${report.windows.length - failed.length}/${report.windows.length} windows clean` +
          (failed.length > 0
            ? ` — leaking: ${failed.map((f) => `"${f.word}" @${f.start.toFixed(2)}s (${f.residual_db}dB > ${f.threshold_db}dB)`).join(', ')}`
            : ' ✓')
      )

      if (report.verified || attempt === maxAttempts) break

      // Self-correct: widen every leaking window and render again.
      words = widenFailures(words, failed, WIDEN_STEP_SEC * attempt)
    }
  } finally {
    for (const f of busFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch { /* non-fatal */ }
    }
  }

  return { words, report: report!, windows }
}
