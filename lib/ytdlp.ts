import path from 'path'
import { execSync, spawn } from 'child_process'

/** Path to the bundled yt-dlp binary, made executable for Vercel's Lambda env. */
export function getYtDlpPath(): string {
  const bin = path.join(process.cwd(), 'bin', 'yt-dlp')
  try { execSync(`chmod +x "${bin}"`, { stdio: 'ignore' }) } catch { /* already executable */ }
  return bin
}

/** Directory containing the ffmpeg-static binary (for yt-dlp's --ffmpeg-location). */
export function getFfmpegDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegBin: string = require('ffmpeg-static')
  try { execSync(`chmod +x "${ffmpegBin}"`, { stdio: 'ignore' }) } catch { /* already executable */ }
  return path.dirname(ffmpegBin)
}

/**
 * Run yt-dlp with the given args. Resolves with { stdout, stderr } on exit 0.
 * Rejects with an Error containing the last 800 chars of stderr on non-zero exit.
 */
export function runYtDlp(ytdlpPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    console.log(`[yt-dlp] ${args.join(' ')}`)
    const proc = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr })
      // Surface a clean error from yt-dlp's stderr
      const tail = stderr.slice(-800).trim()
      reject(new Error(tail || `yt-dlp exited with code ${code}`))
    })
    proc.on('error', (err) => reject(new Error(`Failed to start yt-dlp: ${err.message}`)))
  })
}
