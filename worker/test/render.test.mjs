/**
 * End-to-end censorship proof tests.
 *
 * We synthesize a "song" from first principles so ground truth is exact:
 *   - instrumental = continuous 220 Hz tone (amp 0.35)
 *   - vocals       = 900 Hz bursts (amp 0.45) at known times:
 *       2.0–2.5   profane word  (must be censored)
 *       3.5–4.0   clean word    (must SURVIVE untouched)
 *       5.0–5.6   profane word  (must be censored)
 *       8.2–8.8   profane word  (must be censored)
 *
 * Then we run the real Entity render+verify loop and measure the actual
 * output audio with ffmpeg band filters to prove:
 *   1. the vocal band is gone inside every censored window
 *   2. the instrumental band inside those windows is bit-identical-level
 *   3. clean vocals outside the windows are untouched
 *   4. bleep lays a 1 kHz tone over the window
 *   5. warp crushes the intelligibility band
 *   6. drifted (wrong) timestamps are self-corrected by boundary snapping
 *   7. the verifier honestly FAILS windows that still contain voice
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { censorAndVerify } from '../dist/entity/index.js'
import { verifyRender, measureWindowDb } from '../dist/entity/verify.js'
import { renderCleanAudio } from '../dist/services/audio.js'

const DUR = 12
const CENSOR = [
  [2.0, 2.5],
  [5.0, 5.6],
  [8.2, 8.8],
]
const KEEP = [3.5, 4.0]

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bleeep-entity-test-'))
const P = (name) => path.join(DIR, name)

const VOCAL_BAND = 'bandpass=f=900:width_type=h:w=200,'
const TONE_BAND = 'bandpass=f=1000:width_type=h:w=60,'
// Double lowpass (24 dB/oct): keeps the deliberately-audible warp voice from
// bleeding into the instrumental-preservation measurement.
const INSTR_BAND = 'lowpass=f=400,lowpass=f=400,'
const HI_BAND = 'highpass=f=2500,'

function synth(outName, lavfiSpec, af) {
  const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', lavfiSpec]
  if (af) args.push('-af', af)
  args.push('-c:a', 'pcm_s16le', P(outName))
  execFileSync('ffmpeg', args, { stdio: 'pipe' })
  return P(outName)
}

function mixdown(outName, a, b) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-y', '-i', a, '-i', b,
    '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0[m]',
    '-map', '[m]', '-c:a', 'pcm_s16le', P(outName),
  ], { stdio: 'pipe' })
  return P(outName)
}

const burstsExpr = (wins) => wins.map(([s, e]) => `between(t,${s},${e})`).join('+')

const mkWords = (style) =>
  CENSOR.map(([start, end], i) => ({
    word: `word${i + 1}`,
    start,
    end,
    mute_type: style,
  }))

let vocals, vocalsHi, instrumental, mix, mixHi

before(() => {
  const gate = (wins) => `volume=0.45,volume=enable='not(${burstsExpr(wins)})':volume=0`
  const allBursts = [...CENSOR, KEEP]
  vocals = synth('vocals.wav', `sine=frequency=900:sample_rate=44100:duration=${DUR}`, gate(allBursts))
  vocalsHi = synth('vocals_hi.wav', `sine=frequency=3200:sample_rate=44100:duration=${DUR}`, gate(allBursts))
  instrumental = synth('instrumental.wav', `sine=frequency=220:sample_rate=44100:duration=${DUR}`, 'volume=0.35')
  mix = mixdown('mix.wav', vocals, instrumental)
  mixHi = mixdown('mix_hi.wav', vocalsHi, instrumental)
})

// ── 1. Vocal-only MUTE ────────────────────────────────────────────────────────

test('mute (stems): words silenced, instrumental 100% preserved, clean vocals survive', async () => {
  const out = P('out_mute.mp3')
  const res = await censorAndVerify({
    words: mkWords('mute'),
    outputPath: out,
    vocalsPath: vocals,
    instrumentalPath: instrumental,
    workDir: DIR,
    tag: 'mute',
  })

  assert.equal(res.report.verified, true, JSON.stringify(res.report, null, 2))
  assert.equal(res.report.windows.length, CENSOR.length)

  for (const [s, e] of CENSOR) {
    // 1. Vocal band is GONE from the final mix inside the censored window
    const vocalDb = await measureWindowDb(out, s + 0.05, e - 0.05, VOCAL_BAND)
    assert.ok(vocalDb < -45, `vocal leaked in [${s},${e}]: ${vocalDb} dB`)

    // 2. Instrumental level inside the window matches the raw instrumental
    const instrOut = await measureWindowDb(out, s + 0.05, e - 0.05, INSTR_BAND)
    const instrRef = await measureWindowDb(instrumental, s + 0.05, e - 0.05, INSTR_BAND)
    assert.ok(
      Math.abs(instrOut - instrRef) < 2.0,
      `instrumental altered in [${s},${e}]: out=${instrOut} ref=${instrRef} dB`
    )
  }

  // 3. The clean vocal burst outside the windows is untouched
  const keepOut = await measureWindowDb(out, KEEP[0] + 0.05, KEEP[1] - 0.05, VOCAL_BAND)
  const keepRef = await measureWindowDb(mix, KEEP[0] + 0.05, KEEP[1] - 0.05, VOCAL_BAND)
  assert.ok(
    Math.abs(keepOut - keepRef) < 2.0,
    `clean vocals damaged: out=${keepOut} ref=${keepRef} dB`
  )
})

// ── 2. BLEEP ──────────────────────────────────────────────────────────────────

test('bleep (stems): 1 kHz tone over the window, voice gone, instrumental intact', async () => {
  const out = P('out_bleep.mp3')
  const res = await censorAndVerify({
    words: mkWords('bleep'),
    outputPath: out,
    vocalsPath: vocals,
    instrumentalPath: instrumental,
    workDir: DIR,
    tag: 'bleep',
  })

  assert.equal(res.report.verified, true, JSON.stringify(res.report, null, 2))

  for (const [s, e] of CENSOR) {
    const toneDb = await measureWindowDb(out, s + 0.05, e - 0.05, TONE_BAND)
    assert.ok(toneDb > -30, `bleep tone missing in [${s},${e}]: ${toneDb} dB`)

    // Notch the 1 kHz tone out first — it sits on the vocal band's edge.
    const vocalDb = await measureWindowDb(
      out, s + 0.05, e - 0.05,
      `bandreject=f=1000:width_type=h:w=120,bandreject=f=1000:width_type=h:w=120,${VOCAL_BAND}`
    )
    assert.ok(vocalDb < -40, `vocal leaked under bleep in [${s},${e}]: ${vocalDb} dB`)

    const instrOut = await measureWindowDb(out, s + 0.05, e - 0.05, INSTR_BAND)
    const instrRef = await measureWindowDb(instrumental, s + 0.05, e - 0.05, INSTR_BAND)
    assert.ok(Math.abs(instrOut - instrRef) < 2.0, `instrumental altered: ${instrOut} vs ${instrRef}`)
  }

  // No stray tone outside the censor windows
  const strayTone = await measureWindowDb(out, 6.2, 7.8, TONE_BAND)
  assert.ok(strayTone < -50, `bleep tone leaked outside windows: ${strayTone} dB`)
})

// ── 3. WARP ───────────────────────────────────────────────────────────────────

test('warp (stems): intelligibility band crushed, instrumental intact', async () => {
  const out = P('out_warp.mp3')
  const res = await censorAndVerify({
    words: mkWords('warp'),
    outputPath: out,
    vocalsPath: vocalsHi,
    instrumentalPath: instrumental,
    workDir: DIR,
    tag: 'warp',
  })

  assert.equal(res.report.verified, true, JSON.stringify(res.report, null, 2))

  for (const [s, e] of CENSOR) {
    const hiOut = await measureWindowDb(out, s + 0.05, e - 0.05, HI_BAND)
    const hiRef = await measureWindowDb(mixHi, s + 0.05, e - 0.05, HI_BAND)
    assert.ok(
      hiOut <= hiRef - 12,
      `warp did not crush the consonant band in [${s},${e}]: out=${hiOut} ref=${hiRef} dB`
    )

    const instrOut = await measureWindowDb(out, s + 0.05, e - 0.05, INSTR_BAND)
    const instrRef = await measureWindowDb(instrumental, s + 0.05, e - 0.05, INSTR_BAND)
    assert.ok(Math.abs(instrOut - instrRef) < 2.0, `instrumental altered: ${instrOut} vs ${instrRef}`)
  }
})

// ── 4. Full-mix fallback ──────────────────────────────────────────────────────

test('mute (full-mix fallback): windows silent, clean sections untouched', async () => {
  const out = P('out_fullmix.mp3')
  const res = await censorAndVerify({
    words: mkWords('mute'),
    outputPath: out,
    inputPath: mix,
    workDir: DIR,
    tag: 'fullmix',
  })

  assert.equal(res.report.verified, true, JSON.stringify(res.report, null, 2))

  for (const [s, e] of CENSOR) {
    const db = await measureWindowDb(out, s + 0.05, e - 0.05)
    assert.ok(db < -50, `full-mix window [${s},${e}] not silent: ${db} dB`)
  }
  const keepOut = await measureWindowDb(out, KEEP[0] + 0.05, KEEP[1] - 0.05, VOCAL_BAND)
  const keepRef = await measureWindowDb(mix, KEEP[0] + 0.05, KEEP[1] - 0.05, VOCAL_BAND)
  assert.ok(Math.abs(keepOut - keepRef) < 2.0, `clean section damaged: ${keepOut} vs ${keepRef}`)
})

// ── 5. Self-correction of drifted timestamps ─────────────────────────────────

test('boundary snapping self-corrects drifted ASR timestamps', async () => {
  const out = P('out_snap.mp3')
  // Simulate ASR drift: every timestamp is 120 ms late
  const drifted = CENSOR.map(([s, e], i) => ({
    word: `word${i + 1}`,
    start: +(s + 0.12).toFixed(3),
    end: +(e + 0.12).toFixed(3),
    mute_type: 'mute',
  }))

  const res = await censorAndVerify({
    words: drifted,
    outputPath: out,
    vocalsPath: vocals,
    instrumentalPath: instrumental,
    workDir: DIR,
    tag: 'snap',
    snapToVocalEnergy: true,
  })

  assert.equal(res.report.verified, true, JSON.stringify(res.report, null, 2))

  // The snapped windows must now cover the TRUE word spans: measure the real
  // burst locations on the output — no leaked onset syllable anywhere.
  for (const [s, e] of CENSOR) {
    const vocalDb = await measureWindowDb(out, s + 0.02, e - 0.02, VOCAL_BAND)
    assert.ok(vocalDb < -40, `drifted window leaked the word at [${s},${e}]: ${vocalDb} dB`)
  }
  // …and the snapped word list reflects the corrected boundaries
  assert.ok(res.words[0].start <= 2.02, `start not snapped: ${res.words[0].start}`)
  assert.ok(res.words[0].end >= 2.48, `end not snapped: ${res.words[0].end}`)
})

// ── 6. Verifier honesty ───────────────────────────────────────────────────────

test('verifier FAILS a window that still contains voice (no rubber stamps)', async () => {
  const out = P('out_neg.mp3')
  const bus = P('bus_neg.wav')
  // Censor only word1 — the clean burst at 3.5–4.0 stays in the vocal bus
  const windows = await renderCleanAudio({
    words: [{ word: 'word1', start: 2.0, end: 2.5, mute_type: 'mute' }],
    outputPath: out,
    vocalsPath: vocals,
    instrumentalPath: instrumental,
    vocalBusPath: bus,
  })

  const report = await verifyRender({
    vocalBusPath: bus,
    originalVocalsPath: vocals,
    windows: [
      ...windows,
      // Deliberately claim the KEEP burst was censored — it was not.
      { start: KEEP[0], end: KEEP[1], style: 'mute', words: ['leaky'] },
    ],
    attempt: 1,
  })

  assert.equal(report.verified, false, 'verifier rubber-stamped a leaking window')
  const leaky = report.windows.find((w) => w.word === 'leaky')
  assert.equal(leaky.pass, false)
  assert.ok(leaky.residual_db > -50, `expected loud residual, got ${leaky.residual_db}`)
  const good = report.windows.find((w) => w.word === 'word1')
  assert.equal(good.pass, true)
})

// ── 7. Mixed styles in one render ────────────────────────────────────────────

test('mixed styles (mute + bleep + warp) in one render all verify', async () => {
  const out = P('out_mixed.mp3')
  const words = [
    { word: 'word1', start: CENSOR[0][0], end: CENSOR[0][1], mute_type: 'mute' },
    { word: 'word2', start: CENSOR[1][0], end: CENSOR[1][1], mute_type: 'bleep' },
    { word: 'word3', start: CENSOR[2][0], end: CENSOR[2][1], mute_type: 'warp' },
  ]
  const res = await censorAndVerify({
    words,
    outputPath: out,
    vocalsPath: vocals,
    instrumentalPath: instrumental,
    workDir: DIR,
    tag: 'mixed',
  })
  assert.equal(res.report.verified, true, JSON.stringify(res.report, null, 2))

  // mute window: silence in the vocal band
  const w1 = await measureWindowDb(out, 2.05, 2.45, VOCAL_BAND)
  assert.ok(w1 < -45, `mute leak: ${w1}`)
  // bleep window: tone present
  const w2 = await measureWindowDb(out, 5.05, 5.55, TONE_BAND)
  assert.ok(w2 > -30, `bleep tone missing: ${w2}`)
  // every window: instrumental intact
  for (const [s, e] of CENSOR) {
    const instrOut = await measureWindowDb(out, s + 0.05, e - 0.05, INSTR_BAND)
    const instrRef = await measureWindowDb(instrumental, s + 0.05, e - 0.05, INSTR_BAND)
    assert.ok(Math.abs(instrOut - instrRef) < 2.0, `instrumental altered: ${instrOut} vs ${instrRef}`)
  }
})
