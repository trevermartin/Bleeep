import fs from 'fs'
import type { DetectedWord, MuteType } from '../types'

/**
 * The Entity's render stage: produce the clean MP3 with every detected span
 * censored, without touching a single sample of the instrumental.
 *
 * Three censor styles, selectable PER WORD (`mute_type`):
 *  - mute  — the vocal drops to silence across the span, with short smooth
 *            fade ramps on both edges so there is never a click.
 *  - bleep — the vocal is silenced the same way and a classic 1 kHz tone is
 *            laid over the span.
 *  - warp  — the vocal is replaced by a muffled, pitched-down wobble
 *            (the "No Mistakes" clean-version effect) across the span.
 *
 * Two source modes:
 *  - Vocal-only (preferred): pass `vocalsPath` + `instrumentalPath` (MVSEP
 *    stems). All censoring is applied ONLY to the vocal stem, which is then
 *    summed back with the COMPLETELY UNTOUCHED instrumental, so the music
 *    plays through at 100% even during a censored word.
 *  - Full mix (fallback): pass `inputPath`. Censoring affects the whole mix.
 *
 * `vocalBusPath` (optional) additionally writes the processed vocal bus to a
 * WAV in the same ffmpeg run — the Entity's verification pass measures that
 * file to PROVE each censored window is clean before the job may complete.
 */

/** Edge ramp length for mute/bleep windows (seconds). */
export const FADE_SEC = 0.04

/** A non-overlapping censor window ready for filtergraph construction. */
export interface RenderWindow {
  start: number
  end: number
  style: MuteType
  words: string[]
}

/** Style precedence when overlapping words disagree: harder censor wins. */
const STYLE_RANK: Record<MuteType, number> = { mute: 3, bleep: 2, warp: 1 }

/**
 * Collapse detected words into sorted, non-overlapping render windows.
 * Windows closer than 2×fade merge (their edge ramps would collide).
 * Exported for the test harness.
 */
export function planWindows(words: DetectedWord[], fadeSec: number = FADE_SEC): RenderWindow[] {
  const sorted = [...words]
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const out: RenderWindow[] = []
  for (const w of sorted) {
    const start = Math.max(0, w.start)
    const last = out[out.length - 1]
    if (last && start <= last.end + fadeSec * 2) {
      last.end = Math.max(last.end, w.end)
      if (STYLE_RANK[w.mute_type] > STYLE_RANK[last.style]) last.style = w.mute_type
      last.words.push(w.word)
    } else {
      out.push({ start, end: w.end, style: w.mute_type, words: [w.word] })
    }
  }
  return out
}

const t = (n: number) => n.toFixed(3)

/** Sum-of-betweens expression that is 1 inside any of the given windows. */
function betweenExpr(wins: RenderWindow[]): string {
  return wins.map((w) => `between(t,${t(w.start)},${t(w.end)})`).join('+')
}

/**
 * Smooth trapezoid attenuation for one window: 0 outside, ramping to 1 across
 * `fade` seconds just before `start`, holding 1 through the window, ramping
 * back to 0 across `fade` seconds after `end`.
 */
function rampExpr(w: RenderWindow, fade: number): string {
  const riseFrom = w.start - fade
  const fallTo = w.end + fade
  if (riseFrom <= 0) {
    // Window begins at (or before) t=0 — no rise ramp.
    return `max(0,min(1,(${t(fallTo)}-t)/${t(fade)}))`
  }
  return `max(0,min(1,min((t-${t(riseFrom)})/${t(fade)},(${t(fallTo)}-t)/${t(fade)})))`
}

/**
 * Click-free silencing of every window: gain = 1 − max(window trapezoids),
 * evaluated per frame. asetnsamples=64 shrinks frames to ~1.5 ms so the ramp
 * is effectively continuous. (afade in/out pairs cannot express this — an
 * afade t=in mutes ALL audio before its start point, killing the whole song.)
 */
function fadeSilenceChain(wins: RenderWindow[], fade: number): string {
  const atten = wins
    .map((w) => rampExpr(w, fade))
    .reduce((acc, e) => (acc ? `max(${acc},${e})` : e), '')
  return `asetnsamples=n=64,volume=volume='1-${atten}':eval=frame`
}

/** The warp voice: pitched down, muffled, wobbling — audible but unintelligible.
 *  Two cascaded lowpass biquads (24 dB/oct at 1.2 kHz) crush the consonant
 *  band that carries intelligibility; a single 1800 Hz pole left words
 *  recognizable and failed verification. */
function warpChain(): string {
  return (
    `asetrate=44100*0.8,aresample=44100,atempo=1.25,` +
    `lowpass=f=1200,lowpass=f=1200,` +
    `vibrato=f=6:d=0.8,tremolo=f=10:d=0.6,` +
    `volume=1.8`
  )
}

export interface RenderPlan {
  filterGraph: string
  windows: RenderWindow[]
}

/**
 * Build the complete filtergraph. `srcLabel` is the vocal source ([0:a]),
 * `hasInstrumental` adds the untouched [1:a] sum, `wantVocalBus` splits the
 * processed vocal bus out to [vbus].
 */
export function buildFilterGraph(opts: {
  words: DetectedWord[]
  hasInstrumental: boolean
  wantVocalBus: boolean
  fadeSec?: number
}): RenderPlan {
  const fade = opts.fadeSec ?? FADE_SEC
  const windows = planWindows(opts.words, fade)
  const silenceWins = windows.filter((w) => w.style === 'mute' || w.style === 'bleep')
  const warpWins = windows.filter((w) => w.style === 'warp')
  const bleepWins = windows.filter((w) => w.style === 'bleep')

  const parts: string[] = []

  // ── 1. Vocal processing → [vproc] ─────────────────────────────────────────
  if (warpWins.length > 0) {
    const wb = betweenExpr(warpWins)
    const baseChain = [
      silenceWins.length > 0 ? fadeSilenceChain(silenceWins, fade) : '',
      `volume=enable='${wb}':volume=0`,
    ].filter(Boolean).join(',')
    parts.push(`[0:a]asplit=2[vb][vw]`)
    parts.push(`[vb]${baseChain}[vbase]`)
    parts.push(`[vw]${warpChain()},volume=enable='not(${wb})':volume=0[vwarp]`)
    parts.push(`[vbase][vwarp]amix=inputs=2:normalize=0[vproc]`)
  } else if (silenceWins.length > 0) {
    parts.push(`[0:a]${fadeSilenceChain(silenceWins, fade)}[vproc]`)
  } else {
    parts.push(`[0:a]anull[vproc]`)
  }

  // ── 2. Vocal bus tap → [vbus] (pre-tone, so verification measures the
  //      residual VOICE in every window, never the bleep tone itself) ────────
  let mainLabel = 'vproc'
  if (opts.wantVocalBus) {
    parts.push(`[vproc]asplit=2[vmain][vbus]`)
    mainLabel = 'vmain'
  }

  // ── 3. Bleep tone overlay → [vfinal] ──────────────────────────────────────
  if (bleepWins.length > 0) {
    const toneDur = Math.max(...bleepWins.map((w) => w.end)) + 1
    const bb = betweenExpr(bleepWins)
    // ffmpeg's sine source generates at 1/8 full scale; ×8 restores unity,
    // then ×0.30 sets the classic broadcast-bleep level.
    parts.push(
      `sine=frequency=1000:sample_rate=44100:duration=${t(toneDur)},` +
        `volume=2.4,volume=enable='not(${bb})':volume=0[tone]`
    )
    parts.push(`[${mainLabel}][tone]amix=inputs=2:normalize=0:duration=first[vfinal]`)
  } else {
    parts.push(`[${mainLabel}]anull[vfinal]`)
  }

  // ── 4. Instrumental sum → [out] ───────────────────────────────────────────
  if (opts.hasInstrumental) {
    // Stems sum back to ~original level; normalize=0 keeps full loudness so
    // the music is never ducked.
    parts.push(`[vfinal][1:a]amix=inputs=2:normalize=0[out]`)
  } else {
    parts.push(`[vfinal]anull[out]`)
  }

  return { filterGraph: parts.join(';'), windows }
}

export interface RenderOptions {
  words: DetectedWord[]
  outputPath: string
  inputPath?: string
  vocalsPath?: string
  instrumentalPath?: string
  /** Optional: also write the processed vocal bus (WAV) for verification. */
  vocalBusPath?: string
  fadeSec?: number
}

/** Render the clean output (and optionally the vocal verification bus). */
export async function renderCleanAudio(opts: RenderOptions): Promise<RenderWindow[]> {
  const { words, outputPath, inputPath, vocalsPath, instrumentalPath, vocalBusPath } = opts

  const vocalOnly = !!(vocalsPath && instrumentalPath)
  if (!vocalOnly && !inputPath) {
    throw new Error('renderCleanAudio: no input provided')
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpeg = require('fluent-ffmpeg')
  // No setFfmpegPath: system ffmpeg (installed in the Dockerfile) is on PATH.

  const { filterGraph, windows } = buildFilterGraph({
    words,
    hasInstrumental: vocalOnly,
    wantVocalBus: !!vocalBusPath,
    fadeSec: opts.fadeSec,
  })

  console.log(
    `[audio] render source=${vocalOnly ? 'VOCAL-ONLY' : 'FULL-MIX'} windows=${windows.length} ` +
      `styles=[${windows.map((w) => w.style).join(',')}] bus=${vocalBusPath ? 'yes' : 'no'}`
  )
  console.log(`[audio] filtergraph: ${filterGraph}`)

  return new Promise<RenderWindow[]>((resolve, reject) => {
    const proc = vocalOnly ? ffmpeg(vocalsPath).input(instrumentalPath!) : ffmpeg(inputPath)

    proc.complexFilter(filterGraph)

    proc.output(outputPath).outputOptions(['-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '192k'])
    if (vocalBusPath) {
      proc.output(vocalBusPath).outputOptions(['-map', '[vbus]', '-c:a', 'pcm_s16le'])
    }

    proc
      .on('start', (cmd: string) => {
        console.log(`[audio] ffmpeg command: ${cmd}`)
      })
      .on('end', () => {
        console.log('[audio] ffmpeg render complete')
        resolve(windows)
      })
      .on('error', (err: Error) => {
        console.error('[audio] ffmpeg error:', err.message)
        reject(new Error(`ffmpeg failed: ${err.message}`))
      })
      .run()
  })
}

/** Download a remote file to a local path. */
export async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download audio: HTTP ${res.status}`)
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
}
