import { extractProfaneWords } from './profanity'
import type { DetectedWord, MuteType } from '../types'

interface LrcLine {
  time: number // seconds
  text: string
}

/**
 * Extract artist and track name from a music filename, stripping common
 * noise suffixes.
 *
 * Examples:
 *   "Childish Gambino - Lithonia (Lyrics).mp3"  → { artist: "Childish Gambino", track: "Lithonia" }
 *   "01 - Song Name [HD].mp3"                   → { artist: "",                  track: "Song Name" }
 *   "Artist ft. Other - Track (Official).mp3"   → { artist: "Artist",            track: "Track" }
 *
 * Moved from the Vercel app's lib/lrclib.ts (LRCLIB fetch helpers dropped —
 * unused by the pipeline).
 */
export function parseFilename(filename: string): { artist: string; track: string } {
  let base = filename.replace(/\.[^.]+$/, '').trim()

  // Remove all content inside parentheses or brackets — these are always metadata
  // noise in music filenames: (Lyrics), [HD], (Official Video), (feat. X), etc.
  base = base.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').trim()

  // Remove leading track numbers: "01 - ", "1. ", "02 "
  base = base.replace(/^\d+\s*[\.\-]\s*/, '').trim()

  // Collapse stray multiple spaces left behind by the removals
  base = base.replace(/\s{2,}/g, ' ').trim()

  // Split on first " - " separator for artist / track
  const idx = base.indexOf(' - ')
  if (idx > 0) {
    let artist = base.slice(0, idx).trim()
    const track = base.slice(idx + 3).trim()

    // Strip featured-artist suffixes from the artist field
    artist = artist.replace(/\s+(feat\.?|ft\.?|with|&)\s+.*/i, '').trim()

    return { artist, track }
  }

  return { artist: '', track: base }
}

/**
 * Parse LRC format `[mm:ss.xx]text` into timestamped lines.
 * Handles 1–3 digit fractional seconds.
 */
export function parseLrc(lrcText: string): LrcLine[] {
  const re = /^\[(\d{1,2}):(\d{2})\.(\d{1,3})\](.*)/
  const lines: LrcLine[] = []

  for (const raw of lrcText.split('\n')) {
    const m = raw.match(re)
    if (!m) continue
    const time =
      parseInt(m[1], 10) * 60 +
      parseInt(m[2], 10) +
      parseInt(m[3].padEnd(3, '0'), 10) / 1000
    const text = m[4].trim()
    if (text) lines.push({ time, text })
  }

  return lines.sort((a, b) => a.time - b.time)
}

/**
 * Scan timestamped lyrics for profanity.
 *
 * Each flagged line is muted from 0.5s before its timestamp to exactly
 * the next line's start (covering the full phrase without spilling into
 * the following clean line).
 */
export function detectProfanityInLyrics(lines: LrcLine[], muteType: MuteType): DetectedWord[] {
  const detected: DetectedWord[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const profaneWords = extractProfaneWords(line.text)
    if (profaneWords.length === 0) continue

    // End of this line = start of next line (capped at +6s) or +4s if last line.
    const lineEnd =
      i + 1 < lines.length ? Math.min(lines[i + 1].time, line.time + 6.0) : line.time + 4.0

    const start = Math.max(0, line.time - 0.5)
    const end = lineEnd

    for (const word of profaneWords) {
      detected.push({ word, start, end, mute_type: muteType })
    }
  }

  return detected
}
