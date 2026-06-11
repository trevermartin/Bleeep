/**
 * Downloads the correct yt-dlp standalone binary for the current platform
 * into ./bin/yt-dlp at install time (postinstall).
 *
 * On Vercel the build runs on Linux x86_64, so it downloads yt-dlp_linux.
 * The binary is included in the serverless function bundle via
 * outputFileTracingIncludes in next.config.mjs.
 */
import https from 'https'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const binDir = path.resolve(__dirname, '..', 'bin')
const binPath = path.join(binDir, 'yt-dlp')

if (fs.existsSync(binPath)) {
  const size = fs.statSync(binPath).size
  if (size > 1_000_000) {
    console.log(`[yt-dlp] Binary already present (${(size / 1e6).toFixed(1)} MB), skipping download.`)
    process.exit(0)
  }
  // File exists but is suspiciously small — re-download
  fs.unlinkSync(binPath)
}

const platform = os.platform()
const arch = os.arch()

let binaryName
if (platform === 'linux') {
  binaryName = arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
} else if (platform === 'darwin') {
  binaryName = arch === 'arm64' ? 'yt-dlp_macos' : 'yt-dlp_macos'
} else {
  console.warn(`[yt-dlp] Unsupported platform "${platform}" — skipping binary download.`)
  process.exit(0)
}

const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binaryName}`
console.log(`[yt-dlp] Downloading ${binaryName} from GitHub releases...`)

if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true })

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)

    function get(url) {
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location)
        }
        if (res.statusCode !== 200) {
          file.close()
          fs.unlinkSync(dest)
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`))
        }
        res.pipe(file)
        file.on('finish', () => file.close(resolve))
        file.on('error', (err) => { fs.unlinkSync(dest); reject(err) })
      }).on('error', (err) => { fs.unlinkSync(dest); reject(err) })
    }

    get(url)
  })
}

await download(downloadUrl, binPath)
fs.chmodSync(binPath, 0o755)
const size = fs.statSync(binPath).size
console.log(`[yt-dlp] Downloaded successfully: ${binPath} (${(size / 1e6).toFixed(1)} MB)`)
