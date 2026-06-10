/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'
import toast from 'react-hot-toast'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReviewWord = {
  id: string
  word: string
  start: number
  end: number
  mute_type: 'mute' | 'bleep'
}

interface Props {
  audioUrl: string
  originalFilename: string
  words: ReviewWord[]
  detectionMethod: 'lyrics' | 'ai'
  muteType: 'mute' | 'bleep'
  isReprocessing: boolean
  onWordsChange: (words: ReviewWord[]) => void
  onConfirm: () => void
  onCancel: () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTimeInput(input: string): number {
  const clean = input.trim()
  const m = clean.match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2])
  return parseFloat(clean)
}

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

function censor(word: string): string {
  if (word.length <= 1) return '*'
  return word[0] + '*'.repeat(Math.max(1, word.length - 2)) + word[word.length - 1]
}

const REGION_COLOR = 'rgba(239,68,68,0.22)'
const WS_HEIGHT_NORMAL = 80
const WS_HEIGHT_EXPANDED = 200

// ── Component ─────────────────────────────────────────────────────────────────

export default function WaveformReview({
  audioUrl,
  originalFilename,
  words,
  detectionMethod,
  muteType,
  isReprocessing,
  onWordsChange,
  onConfirm,
  onCancel,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<any>(null)
  const regionsRef = useRef<any>(null)
  const regionMapRef = useRef<Map<string, any>>(new Map()) // wordId -> Region
  const wordsRef = useRef(words)
  const onWordsChangeRef = useRef(onWordsChange)
  const muteTypeRef = useRef(muteType)
  const durationRef = useRef(0)
  // Prevent programmatic setOptions() from echoing back through region-updated
  const programmaticRef = useRef(false)
  // Prevent interaction event from adding a region when user clicked an existing one
  const regionJustClickedRef = useRef(false)
  // Track whether playhead is currently inside a mute zone (avoids spamming setVolume)
  const isInMuteZoneRef = useRef(false)

  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeWordId, setActiveWordId] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [previewWordId, setPreviewWordId] = useState<string | null>(null)
  const previewCleanupRef = useRef<(() => void) | null>(null)
  // Add-region mode: clicking the waveform creates a new 0.5s region
  const [addMode, setAddMode] = useState(false)
  const addModeRef = useRef(false)
  // Expand waveform height
  const [expanded, setExpanded] = useState(false)

  const [newWordTime, setNewWordTime] = useState('')
  const [newWordText, setNewWordText] = useState('')

  // Keep refs current so closures inside event handlers always see the latest values
  useEffect(() => { wordsRef.current = words }, [words])
  useEffect(() => { onWordsChangeRef.current = onWordsChange }, [onWordsChange])
  useEffect(() => { muteTypeRef.current = muteType }, [muteType])
  useEffect(() => { addModeRef.current = addMode }, [addMode])

  // ── WaveSurfer init ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    let destroyed = false

    ;(async () => {
      try {
        const [{ default: WaveSurfer }, { default: RegionsPlugin }] = await Promise.all([
          import('wavesurfer.js'),
          import('wavesurfer.js/dist/plugins/regions.esm.js'),
        ])
        if (destroyed || !containerRef.current) return

        const wsRegions = RegionsPlugin.create()
        const ws = WaveSurfer.create({
          container: containerRef.current,
          waveColor: 'rgba(139,92,246,0.35)',
          progressColor: 'rgba(139,92,246,0.80)',
          cursorColor: '#a78bfa',
          height: WS_HEIGHT_NORMAL,
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          url: audioUrl,
          plugins: [wsRegions],
        })

        wsRef.current = ws
        regionsRef.current = wsRegions

        ws.on('ready', (dur: number) => {
          if (destroyed) return
          setDuration(dur)
          durationRef.current = dur
          setIsLoaded(true)

          // Add one draggable/resizable region per flagged word
          wordsRef.current.forEach((word) => {
            const region = wsRegions.addRegion({
              start: word.start,
              end: word.end,
              color: REGION_COLOR,
              drag: true,
              resize: true,
            })
            regionMapRef.current.set(word.id, region)
          })
        })

        ws.on('error', (err: Error) => {
          if (!destroyed) setLoadError(err?.message ?? 'Failed to load audio')
        })
        ws.on('play', () => {
          if (!destroyed) {
            setIsPlaying(true)
            isInMuteZoneRef.current = false // reset so first-region entry is detected
          }
        })
        ws.on('pause', () => { if (!destroyed) setIsPlaying(false) })
        ws.on('finish', () => {
          if (!destroyed) {
            setIsPlaying(false)
            setActiveWordId(null)
            // Restore volume in case the song ended while muted
            ws.setVolume(1)
            isInMuteZoneRef.current = false
          }
        })

        ws.on('audioprocess', (time: number) => {
          if (destroyed) return
          setCurrentTime(time)

          const active = wordsRef.current.find((w) => time >= w.start && time <= w.end)
          setActiveWordId(active?.id ?? null)

          // ── Real-time mute: silence volume when playhead is inside any flagged region.
          // Only change volume on zone transitions (not every tick) to avoid audio glitches.
          // Skip when a per-word preview is running (it manages volume itself).
          if (!previewCleanupRef.current) {
            const inZone = !!active
            if (inZone !== isInMuteZoneRef.current) {
              isInMuteZoneRef.current = inZone
              ws.setVolume(inZone ? 0 : 1)
            }
          }
        })

        // region-updated fires once when the user finishes dragging or resizing
        wsRegions.on('region-updated', (region: any) => {
          if (destroyed || programmaticRef.current) return
          const entries = Array.from(regionMapRef.current.entries())
          for (const [wordId, r] of entries) {
            if (r === region || r.id === region.id) {
              onWordsChangeRef.current(
                wordsRef.current.map((w) =>
                  w.id === wordId
                    ? { ...w, start: +region.start.toFixed(2), end: +region.end.toFixed(2) }
                    : w
                )
              )
              break
            }
          }
        })

        // Track region clicks so we can skip region-creation when clicking an existing region
        wsRegions.on('region-clicked', () => {
          regionJustClickedRef.current = true
          requestAnimationFrame(() => { regionJustClickedRef.current = false })
        })

        // Click-to-add-region mode: clicking the waveform creates a 0.5s region at that time
        ws.on('interaction', (time: number) => {
          if (destroyed || !addModeRef.current || regionJustClickedRef.current) return
          const half = 0.25
          const dur = durationRef.current
          const newWord: ReviewWord = {
            id: uuidv4(),
            word: 'new',
            start: Math.max(0, +(time - half).toFixed(2)),
            end: dur > 0 ? Math.min(dur, +(time + half).toFixed(2)) : +(time + half).toFixed(2),
            mute_type: muteTypeRef.current,
          }
          const region = regionsRef.current.addRegion({
            start: newWord.start,
            end: newWord.end,
            color: REGION_COLOR,
            drag: true,
            resize: true,
          })
          regionMapRef.current.set(newWord.id, region)
          onWordsChangeRef.current(
            [...wordsRef.current, newWord].sort((a, b) => a.start - b.start)
          )
        })
      } catch (err) {
        if (!destroyed) {
          setLoadError(err instanceof Error ? err.message : 'Failed to initialize waveform')
        }
      }
    })()

    return () => {
      destroyed = true
      previewCleanupRef.current?.()
      if (wsRef.current) {
        wsRef.current.destroy()
        wsRef.current = null
        regionsRef.current = null
        regionMapRef.current.clear()
      }
    }
  }, [audioUrl])

  // ── Expand/collapse waveform height ──────────────────────────────────────
  const toggleExpand = () => {
    setExpanded((prev) => {
      const next = !prev
      wsRef.current?.setOptions({ height: next ? WS_HEIGHT_EXPANDED : WS_HEIGHT_NORMAL })
      return next
    })
  }

  // ── Playback ──────────────────────────────────────────────────────────────
  const togglePlay = () => wsRef.current?.playPause()

  const jumpToWord = (word: ReviewWord) => {
    if (!wsRef.current || !durationRef.current) return
    wsRef.current.seekTo(Math.max(0, word.start - 1.0) / durationRef.current)
    if (!isPlaying) wsRef.current.play()
  }

  // Plays a ~3-second window with the mute applied so the user can hear
  // exactly what the clean version will sound like at that spot.
  // (The per-word preview disables real-time muting while it's running
  //  so it can manage volume itself.)
  const previewWord = useCallback((word: ReviewWord) => {
    if (!wsRef.current || !durationRef.current) return
    if (previewCleanupRef.current) { previewCleanupRef.current(); previewCleanupRef.current = null }

    const ws = wsRef.current
    const previewStart = Math.max(0, word.start - 1.0)
    const previewEnd = word.end + 1.5

    setPreviewWordId(word.id)
    ws.seekTo(previewStart / durationRef.current)

    const handler = (time: number) => {
      ws.setVolume(time >= word.start && time <= word.end ? 0 : 1)
      if (time >= previewEnd) cleanup()
    }
    const cleanup = () => {
      ws.un('audioprocess', handler)
      ws.setVolume(1)
      ws.pause()
      setPreviewWordId(null)
      previewCleanupRef.current = null
      isInMuteZoneRef.current = false // reset so real-time muting picks up correctly
    }
    previewCleanupRef.current = cleanup
    ws.on('audioprocess', handler)
    ws.play()
  }, [])

  // ── Word list operations ──────────────────────────────────────────────────
  const nudgeWord = (id: string, delta: number) => {
    const word = wordsRef.current.find((w) => w.id === id)
    if (!word) return
    const newStart = Math.max(0, +(word.start + delta).toFixed(2))
    const newEnd = Math.max(0, +(word.end + delta).toFixed(2))
    const region = regionMapRef.current.get(id)
    if (region) {
      programmaticRef.current = true
      region.setOptions({ start: newStart, end: newEnd })
      programmaticRef.current = false
    }
    onWordsChange(wordsRef.current.map((w) => w.id === id ? { ...w, start: newStart, end: newEnd } : w))
  }

  const removeWord = (id: string) => {
    const region = regionMapRef.current.get(id)
    if (region) { region.remove(); regionMapRef.current.delete(id) }
    onWordsChange(wordsRef.current.filter((w) => w.id !== id))
  }

  const addWord = () => {
    if (!newWordText.trim()) { toast.error('Enter a word to add'); return }
    const t = parseTimeInput(newWordTime)
    if (isNaN(t)) { toast.error('Enter a valid time like 1:23 or 83'); return }
    const newWord: ReviewWord = {
      id: uuidv4(),
      word: newWordText.trim().toLowerCase(),
      start: Math.max(0, +(t - 1.0).toFixed(2)),
      end: +(t + 1.0).toFixed(2),
      mute_type: muteType,
    }
    if (regionsRef.current) {
      const region = regionsRef.current.addRegion({
        start: newWord.start,
        end: newWord.end,
        color: REGION_COLOR,
        drag: true,
        resize: true,
      })
      regionMapRef.current.set(newWord.id, region)
    }
    onWordsChange([...wordsRef.current, newWord].sort((a, b) => a.start - b.start))
    setNewWordTime('')
    setNewWordText('')
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="mb-8 space-y-4 animate-fade-in">

      {/* Waveform card */}
      <div className="glass rounded-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-0">
          <div>
            <h3 className="text-white font-semibold flex items-center gap-2">
              Review detected words
              {detectionMethod === 'lyrics' ? (
                <span className="text-xs font-normal bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                  Lyrics-assisted
                </span>
              ) : (
                <span className="text-xs font-normal bg-blue-500/20 text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded-full">
                  AI detection
                </span>
              )}
            </h3>
            <p className="text-white/30 text-xs mt-0.5 truncate max-w-xs">{originalFilename}</p>
          </div>
          <button
            onClick={onCancel}
            className="text-white/30 hover:text-white/60 text-sm transition-colors shrink-0 ml-4"
          >
            ← Different file
          </button>
        </div>

        {/* Waveform */}
        <div className="px-4 pt-3 pb-1">
          {loadError ? (
            <div className="h-20 flex items-center justify-center text-red-400/80 text-sm">
              ⚠ {loadError}
            </div>
          ) : (
            <>
              <div
                ref={containerRef}
                className={`w-full transition-all ${isLoaded ? '' : 'hidden'} ${addMode ? 'cursor-crosshair' : ''}`}
              />
              {!isLoaded && (
                <div className="h-20 flex items-center justify-center gap-2 text-white/25 text-sm">
                  <div className="w-3.5 h-3.5 border-2 border-violet-400/50 border-t-violet-400 rounded-full animate-spin" />
                  Loading waveform…
                </div>
              )}
            </>
          )}
        </div>

        {/* Playback controls */}
        <div className="border-t border-white/10 px-4 py-3 flex items-center gap-3 flex-wrap">
          {/* Play/pause */}
          <button
            onClick={togglePlay}
            disabled={!isLoaded || !!loadError}
            className="w-9 h-9 rounded-full bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors shrink-0"
          >
            {isPlaying ? (
              <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7L8 5z" />
              </svg>
            )}
          </button>

          {/* Time display */}
          <span className="text-xs font-mono text-white/40 tabular-nums">
            {fmt(currentTime)} / {fmt(duration)}
          </span>

          {/* Hint */}
          {isLoaded && !addMode && (
            <span className="text-xs text-white/20 hidden sm:block">
              Regions mute audio during playback · drag to adjust
            </span>
          )}
          {isLoaded && addMode && (
            <span className="text-xs text-violet-300/60 hidden sm:block">
              Click anywhere on the waveform to add a mute region
            </span>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Add-region mode toggle */}
          {isLoaded && (
            <button
              onClick={() => setAddMode((v) => !v)}
              title={addMode ? 'Exit add-region mode' : 'Click waveform to add regions'}
              className={`text-xs px-2.5 py-1.5 rounded-lg transition-colors border ${
                addMode
                  ? 'bg-violet-600 border-violet-500 text-white'
                  : 'bg-white/5 border-white/10 text-white/40 hover:text-white hover:bg-white/10'
              }`}
            >
              {addMode ? '✕ adding' : '+ region'}
            </button>
          )}

          {/* Expand/collapse */}
          {isLoaded && (
            <button
              onClick={toggleExpand}
              title={expanded ? 'Collapse waveform' : 'Expand waveform for more detail'}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white hover:bg-white/10 transition-colors"
            >
              {expanded ? '⊟ collapse' : '⊞ expand'}
            </button>
          )}
        </div>
      </div>

      {/* Word list + controls */}
      <div className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white/60 text-xs font-medium uppercase tracking-wider">Flagged words</h3>
          <span className="text-white/30 text-xs">{words.length} found</span>
        </div>

        {words.length === 0 ? (
          <p className="text-white/30 text-sm text-center py-4">
            No words flagged — use the form below to add any missed words, or finalize as clean.
          </p>
        ) : (
          <div className="space-y-1.5">
            {words.map((word) => (
              <div
                key={word.id}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
                  activeWordId === word.id
                    ? 'bg-red-500/15 border border-red-500/30'
                    : 'bg-white/5 border border-transparent hover:border-white/10'
                }`}
              >
                <span className="text-red-400 font-mono text-sm font-bold w-20 shrink-0 truncate">
                  {censor(word.word)}
                </span>
                <span className="text-white/30 text-xs font-mono tabular-nums w-28 shrink-0">
                  {fmt(word.start)} → {fmt(word.end)}
                </span>

                <div className="flex items-center gap-1 ml-auto flex-wrap justify-end">
                  {/* Jump to context */}
                  <button
                    onClick={() => jumpToWord(word)}
                    disabled={!isLoaded}
                    title="Jump to this word and play"
                    className="w-7 h-7 rounded flex items-center justify-center text-white/35 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors text-xs"
                  >
                    ▶
                  </button>

                  {/* Preview with mute applied */}
                  <button
                    onClick={() => previewWord(word)}
                    disabled={!isLoaded || !!previewWordId}
                    title="Preview this 3-second window with the mute applied"
                    className={`w-7 h-7 rounded flex items-center justify-center transition-colors text-xs ${
                      previewWordId === word.id
                        ? 'bg-violet-600 text-white'
                        : 'text-white/35 hover:text-white hover:bg-white/10 disabled:opacity-30'
                    }`}
                  >
                    {previewWordId === word.id ? '◉' : '◎'}
                  </button>

                  {/* Fine nudge -0.1s */}
                  <button
                    onClick={() => nudgeWord(word.id, -0.1)}
                    title="Shift 0.1s earlier"
                    className="text-xs bg-white/5 hover:bg-white/15 text-white/40 hover:text-white px-1 py-1 rounded transition-colors font-mono"
                  >
                    ←·
                  </button>

                  {/* Coarse nudge -0.5s */}
                  <button
                    onClick={() => nudgeWord(word.id, -0.5)}
                    title="Shift 0.5s earlier"
                    className="text-xs bg-white/10 hover:bg-white/20 text-white/50 hover:text-white px-1.5 py-1 rounded transition-colors"
                  >
                    ← 0.5s
                  </button>

                  {/* Coarse nudge +0.5s */}
                  <button
                    onClick={() => nudgeWord(word.id, 0.5)}
                    title="Shift 0.5s later"
                    className="text-xs bg-white/10 hover:bg-white/20 text-white/50 hover:text-white px-1.5 py-1 rounded transition-colors"
                  >
                    0.5s →
                  </button>

                  {/* Fine nudge +0.1s */}
                  <button
                    onClick={() => nudgeWord(word.id, 0.1)}
                    title="Shift 0.1s later"
                    className="text-xs bg-white/5 hover:bg-white/15 text-white/40 hover:text-white px-1 py-1 rounded transition-colors font-mono"
                  >
                    ·→
                  </button>

                  {/* Remove */}
                  <button
                    onClick={() => removeWord(word.id)}
                    title="Remove (false positive)"
                    className="w-7 h-7 flex items-center justify-center rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors ml-1 text-base leading-none"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add missed word */}
        <div className="border-t border-white/10 mt-4 pt-4">
          <p className="text-white/30 text-xs mb-2">Add a missed word</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={newWordTime}
              onChange={(e) => setNewWordTime(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addWord()}
              placeholder="1:23"
              className="w-20 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-violet-500/50"
            />
            <input
              type="text"
              value={newWordText}
              onChange={(e) => setNewWordText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addWord()}
              placeholder="word"
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-violet-500/50"
            />
            <button
              onClick={addWord}
              className="text-xs bg-violet-600/30 hover:bg-violet-600/50 text-violet-300 border border-violet-500/30 px-3 py-1.5 rounded-lg transition-colors"
            >
              + Add
            </button>
          </div>
          <p className="text-white/20 text-xs mt-1.5">
            Format: 1:23 or 83 (seconds). Mutes ±1 second around that timestamp.
          </p>
        </div>

        {/* Finalize */}
        <div className="flex items-center justify-end mt-5 pt-4 border-t border-white/10">
          <button
            onClick={onConfirm}
            disabled={isReprocessing}
            className="shrink-0 bg-violet-600 hover:bg-violet-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium px-5 py-2.5 rounded-xl text-sm transition-colors flex items-center gap-2"
          >
            {isReprocessing ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Processing…
              </>
            ) : words.length > 0 ? (
              `Finalize & Download (${words.length} mute${words.length !== 1 ? 's' : ''})`
            ) : (
              'Finalize & Download (clean track)'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
