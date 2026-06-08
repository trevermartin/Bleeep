import { extractProfaneWords } from './profanity-list'
import type { DetectedWord } from '@/types'

interface LrcLine {
  time: number // seconds
  text: string
}

interface LrclibTrack {
  syncedLyrics: string | null
}

/**
 * Extract artist and track name from a typical music filename.
 * Handles "Artist - Track Name.mp3" and plain "Track Name.mp3".
 */
export function parseFilename(filename: string): { artist: string; track: string } {
  const base = filename.replace(/\.[^.]+$/, '').trim()
  const idx = base.indexOf(' - ')
  if (idx > 0) {
    return { artist: base.slice(0, idx).trim(), track: base.slice(idx + 3).trim() }
  }
  return { artist: '', track: base }
}

/**
 * Query LRCLIB for synced (timestamped) lyrics.
 * Returns LRC text if a match with synced lyrics is found, otherwise null.
 */
export async function fetchLrcLyrics(artist: string, track: string): Promise<string | null> {
  const params = new URLSearchParams({ track_name: track })
  if (artist) params.set('artist_name', artist)

  const res = await fetch(`https://lrclib.net/api/search?${params}`, {
    headers: { 'Lrclib-Client': 'Bleeep v1.0' },
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) return null

  const results: LrclibTrack[] = await res.json()
  const match = results.find((r) => r.syncedLyrics && r.syncedLyrics.trim().length > 0)
  return match?.syncedLyrics ?? null
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
 * Each flagged line is muted from 1s before its timestamp to 1s
 * after the next line's timestamp (covering the full phrase regardless
 * of where in the line the curse word falls).
 */
export function detectProfanityInLyrics(
  lines: LrcLine[],
  muteType: 'mute' | 'bleep'
): DetectedWord[] {
  const detected: DetectedWord[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const profaneWords = extractProfaneWords(line.text)
    if (profaneWords.length === 0) continue

    // End of this line = start of next line (capped at +6s) or +4s if last line.
    // No extra padding past lineEnd — adding +1s here was causing spillover into
    // the first words of the following (clean) line.
    const lineEnd =
      i + 1 < lines.length ? Math.min(lines[i + 1].time, line.time + 6.0) : line.time + 4.0

    const start = Math.max(0, line.time - 0.75)
    const end = lineEnd

    for (const word of profaneWords) {
      detected.push({ word, start, end, mute_type: muteType })
    }
  }

  return detected
}
