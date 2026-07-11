/**
 * Vocal energy envelope analysis — the Entity's ears.
 *
 * ASR word timestamps are routinely 50–150 ms off in sung material, which is
 * exactly how censored versions end up leaking the first consonant of a word.
 * Instead of trusting the transcript blindly, the Entity extracts a 20 ms RMS
 * envelope of the isolated vocal stem (one ffmpeg pass for the whole song)
 * and snaps every censor boundary outward to the nearest energy valley — the
 * natural gap between words — so the full word is always inside the window.
 */

import { spawn } from 'child_process'
import type { DetectedWord } from '../types'

export interface EnvelopeFrame {
  /** Frame start time in seconds. */
  time: number
  /** RMS level of the frame in dB (SILENCE_FLOOR for digital silence). */
  db: number
}

const ENVELOPE_FLOOR_DB = -100
/** 20 ms frames at 44.1 kHz. */
const FRAME_SAMPLES = 882
export const FRAME_SEC = FRAME_SAMPLES / 44100

/** Furthest a boundary may move outward while snapping (seconds). */
const SEARCH_OUT_SEC = 0.18
/** Small inward tolerance (the ASR boundary may sit just past the valley). */
const SEARCH_IN_SEC = 0.04
/** A frame at least this quiet counts as a true inter-word valley. */
const VALLEY_DB = -45
/** Fallback padding when no valley exists (words sung legato). */
const PAD_SEC = 0.06

/**
 * Extract the RMS envelope of an audio file in one ffmpeg pass.
 * 44.1 kHz mono resample keeps frame timing exact regardless of source rate.
 */
export async function extractEnvelope(filePath: string): Promise<EnvelopeFrame[]> {
  const af =
    `aresample=44100,aformat=channel_layouts=mono,asetnsamples=n=${FRAME_SAMPLES},` +
    `astats=metadata=1:reset=1:measure_perchannel=none,` +
    `ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-`
  const args = ['-hide_banner', '-nostats', '-i', filePath, '-af', af, '-f', 'null', '-']

  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = spawn('ffmpeg', args)
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => { out += d.toString() })
    proc.stderr.on('data', (d) => { err += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`ffmpeg envelope pass exited ${code}: ${err.slice(-400)}`))
    })
  })

  const frames: EnvelopeFrame[] = []
  let pendingTime: number | null = null
  for (const line of stdout.split('\n')) {
    const timeMatch = line.match(/pts_time:([\d.]+)/)
    if (timeMatch) {
      pendingTime = parseFloat(timeMatch[1])
      continue
    }
    const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-?inf)/)
    if (rmsMatch && pendingTime !== null) {
      const db = rmsMatch[1].includes('inf') ? ENVELOPE_FLOOR_DB : parseFloat(rmsMatch[1])
      frames.push({ time: pendingTime, db: Number.isFinite(db) ? db : ENVELOPE_FLOOR_DB })
      pendingTime = null
    }
  }
  return frames
}

function framesBetween(env: EnvelopeFrame[], from: number, to: number): EnvelopeFrame[] {
  return env.filter((f) => f.time >= from && f.time <= to)
}

/**
 * Snap one boundary outward to the quietest frame in its search range.
 * `direction` -1 = start boundary (search earlier), +1 = end boundary.
 */
function snapBoundary(env: EnvelopeFrame[], t: number, direction: -1 | 1): number {
  const from = direction === -1 ? t - SEARCH_OUT_SEC : t - SEARCH_IN_SEC
  const to = direction === -1 ? t + SEARCH_IN_SEC : t + SEARCH_OUT_SEC
  const range = framesBetween(env, Math.max(0, from), to)
  if (range.length === 0) return Math.max(0, t + direction * PAD_SEC)

  let best = range[0]
  for (const f of range) if (f.db < best.db) best = f

  if (best.db <= VALLEY_DB) {
    // Land in the middle of the valley frame; include the frame itself on the
    // word side so the ramp finishes inside silence.
    return Math.max(0, direction === -1 ? best.time : best.time + FRAME_SEC)
  }
  // No true gap (legato singing) — fall back to fixed outward padding.
  return Math.max(0, t + direction * PAD_SEC)
}

/**
 * Snap every word's boundaries to the vocal stem's energy valleys.
 * Never moves a boundary inward past the ASR span; windows can only grow
 * or shift to natural silences, so nothing that was covered gets uncovered.
 */
export function snapWordsToValleys(
  words: DetectedWord[],
  env: EnvelopeFrame[]
): DetectedWord[] {
  if (env.length === 0) return words
  return words.map((w) => {
    const snappedStart = Math.min(snapBoundary(env, w.start, -1), w.start)
    const snappedEnd = Math.max(snapBoundary(env, w.end, 1), w.end)
    if (snappedEnd <= snappedStart) return w
    return { ...w, start: +snappedStart.toFixed(3), end: +snappedEnd.toFixed(3) }
  })
}
