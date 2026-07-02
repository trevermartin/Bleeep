import fs from 'fs'
import { spawn } from 'child_process'

/**
 * Worker-native yt-dlp wrapper.
 *
 * The Vercel app shipped a bundled yt-dlp binary in bin/ and pointed it at the
 * ffmpeg-static binary via --ffmpeg-location. The worker's Docker image instead
 * installs system yt-dlp (pip) and system ffmpeg (apt), both on PATH, so there
 * is no bundled binary and no --ffmpeg-location to pass.
 */

/**
 * Run system yt-dlp. Resolves { stdout, stderr } on exit 0.
 * Rejects with the last 800 chars of stderr on non-zero exit.
 */
export function runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    console.log(`[yt-dlp] ${args.join(' ')}`)
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr })
      const tail = stderr.slice(-800).trim()
      reject(new Error(tail || `yt-dlp exited with code ${code}`))
    })
    proc.on('error', (err) => reject(new Error(`Failed to start yt-dlp: ${err.message}`)))
  })
}

function sanitize(s: string): string {
  return s.replace(/[/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim()
}

/** Build a "Artist - Title.mp3" filename from track metadata. */
export function buildFilename(title: string, artist: string): string {
  const cleanTitle = sanitize(title)
  const cleanArtist = sanitize(artist)
  if (cleanArtist && !cleanTitle.toLowerCase().includes(cleanArtist.toLowerCase())) {
    return `${cleanArtist} - ${cleanTitle}.mp3`
  }
  return `${cleanTitle}.mp3`
}

/** Fetch SoundCloud track metadata (uploader + title) without downloading. */
export async function fetchSoundCloudMetadata(
  url: string
): Promise<{ artist: string; title: string }> {
  const { stdout } = await runYtDlp([
    '--no-playlist',
    '--print',
    '%(uploader)s|||%(title)s',
    url,
  ])
  const line = stdout.trim().split('\n')[0] ?? ''
  const sep = line.indexOf('|||')
  if (sep !== -1) {
    return { artist: line.slice(0, sep).trim(), title: line.slice(sep + 3).trim() }
  }
  return { artist: '', title: line || 'Unknown Track' }
}

/**
 * Download a SoundCloud track and convert it to MP3 at `mp3Path`.
 * Throws if the output file is missing after yt-dlp exits.
 */
export async function downloadSoundCloudMp3(url: string, mp3Path: string): Promise<void> {
  await runYtDlp([
    '--no-playlist',
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '0',
    '-o',
    mp3Path,
    url,
  ])
  if (!fs.existsSync(mp3Path)) {
    throw new Error('Download completed but output MP3 file not found')
  }
}
