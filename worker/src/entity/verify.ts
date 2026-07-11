/**
 * The Entity's verification pass — it never trusts its own render.
 *
 * After every render, the processed vocal bus (written by ffmpeg in the same
 * run as the clean mix) is measured window by window:
 *
 *  - mute / bleep windows must be effectively SILENT on the vocal bus
 *    (residual RMS below MUTE_THRESHOLD_DB). The bus is tapped before the
 *    bleep tone is mixed in, so a bleep can never mask leaked vocals.
 *  - warp windows must have their intelligibility band (>2.5 kHz consonant
 *    energy) crushed relative to the original vocal, proving the word is
 *    obscured even though sound remains.
 *
 * The instrumental never enters the measured bus, so a pass here means the
 * voice is gone from the window while the music was untouched by construction.
 */

import { spawn } from 'child_process'
import type { MuteType, VerificationReport, VerificationWindow } from '../types'
import type { RenderWindow } from '../services/audio'

/** Residual vocal level allowed inside a mute/bleep window. */
export const MUTE_THRESHOLD_DB = -50
/** Warp: high-band must drop at least this much vs the original vocal… */
export const WARP_HI_DROP_DB = 12
/** …or be absolutely quiet. */
export const WARP_HI_ABS_DB = -45
/** Floor used when ffmpeg reports -inf (digital silence). */
export const SILENCE_FLOOR_DB = -120

/**
 * Measure the overall RMS level (dB) of `filePath` between `start` and `end`,
 * optionally through an extra filter (e.g. "highpass=f=2500," to isolate a
 * band) applied before measurement.
 */
export async function measureWindowDb(
  filePath: string,
  start: number,
  end: number,
  preFilter = ''
): Promise<number> {
  const af = `atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},${preFilter}astats=measure_perchannel=none`
  const args = ['-hide_banner', '-nostats', '-i', filePath, '-af', af, '-f', 'null', '-']

  const stderr = await new Promise<string>((resolve, reject) => {
    const proc = spawn('ffmpeg', args)
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(err)
      else reject(new Error(`ffmpeg astats exited ${code}: ${err.slice(-400)}`))
    })
  })

  const matches = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-?inf)/gi)]
  if (matches.length === 0) throw new Error('astats produced no RMS measurement')
  const raw = matches[matches.length - 1][1]
  const db = raw.includes('inf') ? SILENCE_FLOOR_DB : parseFloat(raw)
  return Number.isFinite(db) ? db : SILENCE_FLOOR_DB
}

export interface VerifyOptions {
  /** Processed vocal bus WAV written by renderCleanAudio. */
  vocalBusPath: string
  /** The untouched vocal source (stem, or full mix in fallback mode). */
  originalVocalsPath: string
  windows: RenderWindow[]
  attempt: number
}

/** Measure every censor window and return the Entity's verdict. */
export async function verifyRender(opts: VerifyOptions): Promise<VerificationReport> {
  const results: VerificationWindow[] = []

  for (const win of opts.windows) {
    const style: MuteType = win.style
    let residualDb: number
    let thresholdDb: number
    let pass: boolean

    if (style === 'warp') {
      const HI = 'highpass=f=2500,'
      const [busHi, origHi] = await Promise.all([
        measureWindowDb(opts.vocalBusPath, win.start, win.end, HI),
        measureWindowDb(opts.originalVocalsPath, win.start, win.end, HI),
      ])
      residualDb = busHi
      thresholdDb = Math.max(origHi - WARP_HI_DROP_DB, WARP_HI_ABS_DB)
      // Pass when the consonant band dropped enough, or was never there.
      pass = busHi <= origHi - WARP_HI_DROP_DB || busHi <= WARP_HI_ABS_DB
    } else {
      residualDb = await measureWindowDb(opts.vocalBusPath, win.start, win.end)
      thresholdDb = MUTE_THRESHOLD_DB
      pass = residualDb <= MUTE_THRESHOLD_DB
    }

    results.push({
      word: win.words.join(' '),
      start: win.start,
      end: win.end,
      style,
      residual_db: Math.round(residualDb * 10) / 10,
      threshold_db: Math.round(thresholdDb * 10) / 10,
      pass,
    })
  }

  return {
    verified: results.every((r) => r.pass),
    attempts: opts.attempt,
    windows: results,
    checked_at: new Date().toISOString(),
  }
}
