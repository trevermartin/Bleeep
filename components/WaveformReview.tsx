/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, react/no-unescaped-entities */
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
  mute_type: 'mute' | 'warp'
}

interface Props {
  audioUrl: string
  originalFilename: string
  words: ReviewWord[]
  detectionMethod: 'lyrics' | 'ai' | 'community'
  muteType: 'mute' | 'warp'
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

const MUTE_REGION_COLOR = 'rgba(239,68,68,0.22)'
const WARP_REGION_COLOR = 'rgba(139,92,246,0.30)'
const regionColor = (t: 'mute' | 'warp') => (t === 'warp' ? WARP_REGION_COLOR : MUTE_REGION_COLOR)
const regionContent = (t: 'mute' | 'warp') => (t === 'warp' ? 'WARP' : undefined)
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
  const programmaticRef = useRef(false)   // guard: setOptions() shouldn't fire region-updated
  const regionJustClickedRef = useRef(false) // guard: region click shouldn't also add a region
  const isInMuteZoneRef = useRef(false)   // track mute-zone transitions for real-time mute

  // ── Initial word positions — snapshot at mount for copy/paste offset calc
  const initialWordsRef = useRef<ReviewWord[]>(words)

  // ── Undo history stack (up to 20 states)
  const historyRef = useRef<ReviewWord[][]>([])
  const [historyLength, setHistoryLength] = useState(0)

  // ── Copy/paste clipboard
  const [copiedDelta, setCopiedDelta] = useState<number | null>(null)
  const [copiedFromId, setCopiedFromId] = useState<string | null>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeWordId, setActiveWordId] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [previewWordId, setPreviewWordId] = useState<string | null>(null)
  const previewCleanupRef = useRef<(() => void) | null>(null)

  const [addMode, setAddMode] = useState(false)
  const addModeRef = useRef(false)
  const [expanded, setExpanded] = useState(false)

  // Mute-preview toggle (ON = silenced during regions; OFF = hear original)
  const [mutePreviewEnabled, setMutePreviewEnabled] = useState(true)
  const mutePreviewEnabledRef = useRef(true)
  useEffect(() => { mutePreviewEnabledRef.current = mutePreviewEnabled }, [mutePreviewEnabled])

  // Scheduled gain changes — stored so they can be cancelled on pause/seek
  const gainTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([])
  // Exposed by the WaveSurfer init closure so the toggle button can call it
  const scheduleMutesRef = useRef<((fromTime: number) => void) | null>(null)

  const [newWordTime, setNewWordTime] = useState('')
  const [newWordText, setNewWordText] = useState('')

  // Keep refs current so closures inside event handlers always see the latest values
  useEffect(() => {
    wordsRef.current = words
    // If playing, reschedule mutes because region positions may have changed
    if (wsRef.current && isPlaying && !previewCleanupRef.current) {
      scheduleMutesRef.current?.(wsRef.current.getCurrentTime())
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words])
  useEffect(() => { onWordsChangeRef.current = onWordsChange }, [onWordsChange])
  useEffect(() => { muteTypeRef.current = muteType }, [muteType])
  useEffect(() => { addModeRef.current = addMode }, [addMode])

  // ── Shared push-to-history used by all mutating functions ─────────────────
  // Inlined at call sites for event-handler closures (where the function ref
  // would be stale). Regular component functions call this helper directly.
  function pushHistory(snapshot: ReviewWord[]) {
    const next = [...historyRef.current.slice(-19), snapshot.map((w) => ({ ...w }))]
    historyRef.current = next
    setHistoryLength(next.length) // setState setter is always stable
  }

  // ── Rebuild all waveform regions from a word list (used by undo) ──────────
  function rebuildRegions(wordList: ReviewWord[]) {
    if (!regionsRef.current) return
    // Remove all existing regions
    Array.from(regionMapRef.current.values()).forEach((r) => r.remove())
    regionMapRef.current.clear()
    wordList.forEach((word) => {
      const region = regionsRef.current.addRegion({
        start: word.start,
        end: word.end,
        color: regionColor(word.mute_type),
        content: regionContent(word.mute_type),
        drag: true,
        resize: true,
      })
      regionMapRef.current.set(word.id, region)
    })
  }

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

        // ── Precise mute scheduling via setTimeout ─────────────────────────────
        // Much more accurate than audioprocess polling (~4ms vs ~50ms jitter).
        // Schedule a setVolume(0) + setVolume(1) pair for every mute region,
        // timed relative to the current playback position.
        const scheduleMutes = (fromTime: number) => {
          gainTimeoutsRef.current.forEach(clearTimeout)
          gainTimeoutsRef.current = []
          // Skip when mute preview is disabled or a per-word preview owns volume
          if (!mutePreviewEnabledRef.current || previewCleanupRef.current) return

          for (const word of wordsRef.current) {
            const startMs = (word.start - fromTime) * 1000
            const endMs = (word.end - fromTime) * 1000
            if (endMs <= 0) continue // already past end

            // Warp regions duck to ~20% (a muffled preview) instead of full silence
            const zoneVol = word.mute_type === 'warp' ? 0.2 : 0
            if (startMs <= 0) {
              // Playback started inside a mute zone — duck immediately
              ws.setVolume(zoneVol)
            } else {
              gainTimeoutsRef.current.push(
                setTimeout(() => { if (!previewCleanupRef.current) ws.setVolume(zoneVol) }, startMs)
              )
            }
            gainTimeoutsRef.current.push(
              setTimeout(() => { if (!previewCleanupRef.current) ws.setVolume(1) }, endMs)
            )
          }
        }
        scheduleMutesRef.current = scheduleMutes

        ws.on('ready', (dur: number) => {
          if (destroyed) return
          setDuration(dur)
          durationRef.current = dur
          setIsLoaded(true)
          wordsRef.current.forEach((word) => {
            const region = wsRegions.addRegion({
              start: word.start,
              end: word.end,
              color: regionColor(word.mute_type),
              content: regionContent(word.mute_type),
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
            isInMuteZoneRef.current = false
            scheduleMutes(ws.getCurrentTime())
          }
        })

        ws.on('pause', () => {
          if (!destroyed) {
            setIsPlaying(false)
            gainTimeoutsRef.current.forEach(clearTimeout)
            gainTimeoutsRef.current = []
            if (!previewCleanupRef.current) ws.setVolume(1)
          }
        })

        ws.on('finish', () => {
          if (!destroyed) {
            setIsPlaying(false)
            setActiveWordId(null)
            gainTimeoutsRef.current.forEach(clearTimeout)
            gainTimeoutsRef.current = []
            ws.setVolume(1)
            isInMuteZoneRef.current = false
          }
        })

        ws.on('audioprocess', (time: number) => {
          if (destroyed) return
          setCurrentTime(time)
          const active = wordsRef.current.find((w) => time >= w.start && time <= w.end)
          setActiveWordId(active?.id ?? null)
          // Volume is managed by scheduled timeouts above, not by polling here
        })

        // region-updated fires once on mouse-up after drag/resize
        wsRegions.on('region-updated', (region: any) => {
          if (destroyed || programmaticRef.current) return
          const entries = Array.from(regionMapRef.current.entries())
          for (const [wordId, r] of entries) {
            if (r === region || r.id === region.id) {
              // Push history before applying the drag (setHistoryLength setter is stable)
              const snap = wordsRef.current.map((w) => ({ ...w }))
              historyRef.current = [...historyRef.current.slice(-19), snap]
              setHistoryLength(historyRef.current.length)
              const draggedWords = wordsRef.current.map((w) =>
                w.id === wordId
                  ? { ...w, start: +region.start.toFixed(2), end: +region.end.toFixed(2) }
                  : w
              )
              wordsRef.current = draggedWords
              onWordsChangeRef.current(draggedWords)
              break
            }
          }
        })

        // Prevent region-click from also creating a new region in add-mode
        wsRegions.on('region-clicked', () => {
          regionJustClickedRef.current = true
          requestAnimationFrame(() => { regionJustClickedRef.current = false })
        })

        // Click-to-add-region mode + reschedule mutes on seek
        ws.on('interaction', (time: number) => {
          if (destroyed) return
          // Reschedule mutes from the new seek position
          scheduleMutes(time)
          if (!addModeRef.current || regionJustClickedRef.current) return
          const snap = wordsRef.current.map((w) => ({ ...w }))
          historyRef.current = [...historyRef.current.slice(-19), snap]
          setHistoryLength(historyRef.current.length)
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
            color: regionColor(newWord.mute_type),
            content: regionContent(newWord.mute_type),
            drag: true,
            resize: true,
          })
          regionMapRef.current.set(newWord.id, region)
          const clickAddedWords = [...wordsRef.current, newWord].sort((a, b) => a.start - b.start)
          wordsRef.current = clickAddedWords
          onWordsChangeRef.current(clickAddedWords)
          // Exit add-region mode after adding one region so the user isn't
          // stuck in add mode (the "+ region" button toggles back off).
          addModeRef.current = false
          setAddMode(false)
        })
      } catch (err) {
        if (!destroyed) {
          setLoadError(err instanceof Error ? err.message : 'Failed to initialize waveform')
        }
      }
    })()

    return () => {
      destroyed = true
      gainTimeoutsRef.current.forEach(clearTimeout)
      gainTimeoutsRef.current = []
      scheduleMutesRef.current = null
      previewCleanupRef.current?.()
      if (wsRef.current) {
        wsRef.current.destroy()
        wsRef.current = null
        regionsRef.current = null
        // eslint-disable-next-line react-hooks/exhaustive-deps
        regionMapRef.current.clear()
      }
    }
  }, [audioUrl])

  // ── Undo: Cmd+Z / Ctrl+Z keyboard shortcut ───────────────────────────────
  const handleUndo = useCallback(() => {
    if (historyRef.current.length === 0) {
      toast('Nothing to undo', { icon: 'ℹ️', duration: 1200 })
      return
    }
    const prev = historyRef.current[historyRef.current.length - 1]
    historyRef.current = historyRef.current.slice(0, -1)
    setHistoryLength(historyRef.current.length)
    rebuildRegions(prev)
    wordsRef.current = prev
    onWordsChangeRef.current(prev)
  }, []) // only accesses stable refs and setState setters

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault()
        handleUndo()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleUndo])

  // ── Expand/collapse waveform ──────────────────────────────────────────────
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
      isInMuteZoneRef.current = false
    }
    previewCleanupRef.current = cleanup
    ws.on('audioprocess', handler)
    ws.play()
  }, [])

  // ── Word mutations ────────────────────────────────────────────────────────

  const nudgeWord = (id: string, delta: number) => {
    const word = wordsRef.current.find((w) => w.id === id)
    if (!word) return
    pushHistory(wordsRef.current)
    const newStart = Math.max(0, +(word.start + delta).toFixed(2))
    const newEnd = Math.max(0, +(word.end + delta).toFixed(2))
    const region = regionMapRef.current.get(id)
    if (region) {
      programmaticRef.current = true
      region.setOptions({ start: newStart, end: newEnd })
      programmaticRef.current = false
    }
    const newWords = wordsRef.current.map((w) => w.id === id ? { ...w, start: newStart, end: newEnd } : w)
    wordsRef.current = newWords
    onWordsChange(newWords)
  }

  // Expand (+) or shrink (−) the mute window symmetrically from its center.
  // delta = +0.05 to grow 0.1s total, -0.05 to shrink; minimum window = 0.1s.
  const resizeWord = (id: string, delta: number) => {
    const word = wordsRef.current.find((w) => w.id === id)
    if (!word) return
    const half = (word.end - word.start) / 2
    const newHalf = Math.max(0.05, half + delta)
    const center = (word.start + word.end) / 2
    const newStart = Math.max(0, +(center - newHalf).toFixed(2))
    const newEnd = +(center + newHalf).toFixed(2)
    pushHistory(wordsRef.current)
    const region = regionMapRef.current.get(id)
    if (region) {
      programmaticRef.current = true
      region.setOptions({ start: newStart, end: newEnd })
      programmaticRef.current = false
    }
    const newWords = wordsRef.current.map((w) => w.id === id ? { ...w, start: newStart, end: newEnd } : w)
    wordsRef.current = newWords
    onWordsChange(newWords)
  }

  const removeWord = (id: string) => {
    pushHistory(wordsRef.current)
    const region = regionMapRef.current.get(id)
    if (region) { region.remove(); regionMapRef.current.delete(id) }
    const newWords = wordsRef.current.filter((w) => w.id !== id)
    wordsRef.current = newWords
    onWordsChange(newWords)
  }

  const addWord = () => {
    const t = parseTimeInput(newWordTime)
    if (isNaN(t)) { toast.error('Enter a valid time like 1:23 or 83'); return }
    pushHistory(wordsRef.current)
    const newWord: ReviewWord = {
      id: uuidv4(),
      word: newWordText.trim().toLowerCase() || 'new',
      start: Math.max(0, +(t - 1.0).toFixed(2)),
      end: +(t + 1.0).toFixed(2),
      mute_type: muteType,
    }
    if (regionsRef.current) {
      const region = regionsRef.current.addRegion({
        start: newWord.start,
        end: newWord.end,
        color: regionColor(newWord.mute_type),
        content: regionContent(newWord.mute_type),
        drag: true,
        resize: true,
      })
      regionMapRef.current.set(newWord.id, region)
    }
    const newWords = [...wordsRef.current, newWord].sort((a, b) => a.start - b.start)
    wordsRef.current = newWords
    onWordsChange(newWords)
    setNewWordTime('')
    setNewWordText('')
  }

  // ── Copy / Paste timing ───────────────────────────────────────────────────

  // Copy the offset this word was shifted from its originally-detected position.
  // Paste applies that same shift to another word's original position.
  const copyTiming = (word: ReviewWord) => {
    const original = initialWordsRef.current.find((w) => w.id === word.id)
    const delta = original ? +(word.start - original.start).toFixed(2) : 0
    setCopiedDelta(delta)
    setCopiedFromId(word.id)
    const sign = delta >= 0 ? '+' : ''
    toast.success(`Offset ${sign}${delta}s copied`, { duration: 1500 })
  }

  const pasteTiming = (targetWord: ReviewWord) => {
    if (copiedDelta === null) return
    const original = initialWordsRef.current.find((w) => w.id === targetWord.id)
    // Apply the delta from the original detected position; fall back to current if no original
    const baseStart = original ? original.start : targetWord.start
    const baseEnd = original ? original.end : targetWord.end
    const newStart = Math.max(0, +(baseStart + copiedDelta).toFixed(2))
    const newEnd = +(baseEnd + copiedDelta).toFixed(2)
    pushHistory(wordsRef.current)
    const region = regionMapRef.current.get(targetWord.id)
    if (region) {
      programmaticRef.current = true
      region.setOptions({ start: newStart, end: newEnd })
      programmaticRef.current = false
    }
    const newWords = wordsRef.current.map((w) =>
      w.id === targetWord.id ? { ...w, start: newStart, end: newEnd } : w
    )
    wordsRef.current = newWords
    onWordsChange(newWords)
  }

  // ── Button style helpers ──────────────────────────────────────────────────
  const btnSm = 'text-xs bg-white/10 hover:bg-white/20 text-white/50 hover:text-white px-1.5 py-1 rounded transition-colors'
  const btnIcon = 'w-7 h-7 rounded flex items-center justify-center text-white/35 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors text-xs'

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="mb-8 space-y-4 animate-fade-in">

      {/* ── Waveform card ──────────────────────────────────────────────── */}
      <div className="glass rounded-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-0">
          <div>
            <h3 className="text-white font-semibold flex items-center gap-2">
              Review detected words
              {detectionMethod === 'community' ? (
                <span className="text-xs font-normal bg-violet-500/20 text-violet-300 border border-violet-500/30 px-2 py-0.5 rounded-full">
                  Community verified ✓
                </span>
              ) : detectionMethod === 'lyrics' ? (
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

        {/* Playback + tool controls */}
        <div className="border-t border-white/10 px-4 py-3 flex items-center gap-2 flex-wrap">
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

          {/* Time */}
          <span className="text-xs font-mono text-white/40 tabular-nums">
            {fmt(currentTime)} / {fmt(duration)}
          </span>

          {/* Context hint */}
          {isLoaded && !addMode && (
            <span className="text-xs text-white/20 hidden sm:block">
              Regions mute audio during playback · drag to adjust
            </span>
          )}
          {isLoaded && addMode && (
            <span className="text-xs text-violet-300/60 hidden sm:block">
              Click waveform to add a mute region
            </span>
          )}

          <div className="flex-1" />

          {/* Mute preview ON/OFF pill toggle */}
          {isLoaded && (
            <button
              onClick={() => {
                setMutePreviewEnabled((prev) => {
                  const next = !prev
                  mutePreviewEnabledRef.current = next
                  if (!next) {
                    // Turning off — cancel scheduled mutes and restore volume
                    gainTimeoutsRef.current.forEach(clearTimeout)
                    gainTimeoutsRef.current = []
                    if (!previewCleanupRef.current) wsRef.current?.setVolume(1)
                  } else if (isPlaying && !previewCleanupRef.current) {
                    // Turning on mid-playback — reschedule from current position
                    scheduleMutesRef.current?.(wsRef.current?.getCurrentTime() ?? 0)
                  }
                  return next
                })
              }}
              title={mutePreviewEnabled
                ? 'Mute preview ON — click to hear original audio'
                : 'Mute preview OFF — click to silence profanity during playback'}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all border shrink-0 ${
                mutePreviewEnabled
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                  : 'bg-white/5 border-white/15 text-white/35 hover:bg-white/10 hover:text-white/60'
              }`}
            >
              <span className={`w-2 h-2 rounded-full transition-colors shrink-0 ${
                mutePreviewEnabled ? 'bg-emerald-400' : 'bg-white/20'
              }`} />
              Mute: {mutePreviewEnabled ? 'ON' : 'OFF'}
            </button>
          )}

          {/* Undo button */}
          {isLoaded && (
            <button
              onClick={handleUndo}
              disabled={historyLength === 0}
              title="Undo last change (Cmd+Z / Ctrl+Z)"
              className="text-xs px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white hover:bg-white/10 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
            >
              ↩{historyLength > 0 ? ` ${historyLength}` : ''}
            </button>
          )}

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

          {/* Expand/collapse waveform */}
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

      {/* ── Word list ─────────────────────────────────────────────────── */}
      <div className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white/60 text-xs font-medium uppercase tracking-wider">Flagged words</h3>
          <div className="flex items-center gap-3">
            {copiedDelta !== null && (
              <span className="text-xs text-violet-300/70">
                offset {copiedDelta >= 0 ? '+' : ''}{copiedDelta}s copied
                <button onClick={() => { setCopiedDelta(null); setCopiedFromId(null) }} className="ml-1.5 text-white/30 hover:text-white/60">×</button>
              </span>
            )}
            <span className="text-white/30 text-xs">{words.length} found</span>
          </div>
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
                className={`flex items-center gap-2 rounded-lg px-3 py-2 transition-colors flex-wrap ${
                  activeWordId === word.id
                    ? 'bg-red-500/15 border border-red-500/30'
                    : 'bg-white/5 border border-transparent hover:border-white/10'
                }`}
              >
                {/* Word + timestamp */}
                <span className="text-red-400 font-mono text-sm font-bold w-20 shrink-0 truncate">
                  {censor(word.word)}
                </span>
                <span className="text-white/30 text-xs font-mono tabular-nums w-28 shrink-0">
                  {fmt(word.start)} → {fmt(word.end)}
                </span>

                {/* Controls */}
                <div className="flex items-center gap-1 ml-auto flex-wrap justify-end">

                  {/* Playback: jump + preview */}
                  <button onClick={() => jumpToWord(word)} disabled={!isLoaded} title="Jump to this word" className={btnIcon}>▶</button>
                  <button
                    onClick={() => previewWord(word)}
                    disabled={!isLoaded || !!previewWordId}
                    title="Preview 3s window with mute applied"
                    className={`${btnIcon} ${previewWordId === word.id ? 'bg-violet-600 text-white' : ''}`}
                  >
                    {previewWordId === word.id ? '◉' : '◎'}
                  </button>

                  {/* Divider */}
                  <span className="w-px h-4 bg-white/10 mx-0.5" />

                  {/* Copy / Paste */}
                  <button
                    onClick={() => copyTiming(word)}
                    title="Copy this word's timing offset"
                    className={`${btnSm} ${copiedFromId === word.id ? '!bg-violet-600/30 !text-violet-300 border border-violet-500/30' : ''}`}
                  >
                    copy
                  </button>
                  {copiedDelta !== null && copiedFromId !== word.id && (
                    <button
                      onClick={() => pasteTiming(word)}
                      title={`Paste offset ${copiedDelta >= 0 ? '+' : ''}${copiedDelta}s`}
                      className={`${btnSm} !bg-violet-600/20 !text-violet-300 border border-violet-500/20`}
                    >
                      paste
                    </button>
                  )}

                  {/* Divider */}
                  <span className="w-px h-4 bg-white/10 mx-0.5" />

                  {/* Resize −/+ */}
                  <button onClick={() => resizeWord(word.id, -0.05)} title="Shrink region by 0.1s" className={btnSm}>−</button>
                  <button onClick={() => resizeWord(word.id, 0.05)} title="Expand region by 0.1s" className={btnSm}>+</button>

                  {/* Divider */}
                  <span className="w-px h-4 bg-white/10 mx-0.5" />

                  {/* Fine nudge ±0.1s */}
                  <button onClick={() => nudgeWord(word.id, -0.1)} title="Shift 0.1s earlier" className="text-xs bg-white/5 hover:bg-white/15 text-white/40 hover:text-white px-1 py-1 rounded transition-colors font-mono">←·</button>
                  {/* Coarse nudge ±0.5s */}
                  <button onClick={() => nudgeWord(word.id, -0.5)} title="Shift 0.5s earlier" className={btnSm}>← 0.5s</button>
                  <button onClick={() => nudgeWord(word.id, 0.5)} title="Shift 0.5s later" className={btnSm}>0.5s →</button>
                  <button onClick={() => nudgeWord(word.id, 0.1)} title="Shift 0.1s later" className="text-xs bg-white/5 hover:bg-white/15 text-white/40 hover:text-white px-1 py-1 rounded transition-colors font-mono">·→</button>

                  {/* Remove */}
                  <span className="w-px h-4 bg-white/10 mx-0.5" />
                  <button
                    onClick={() => removeWord(word.id)}
                    title="Remove (false positive)"
                    className="w-7 h-7 flex items-center justify-center rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors ml-0.5 text-base leading-none"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add missed word form */}
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
              placeholder="word (optional)"
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
            Timestamp required (1:23 or 83s). Word label is optional — defaults to &ldquo;new&rdquo;.
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
