'use client'

import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { v4 as uuidv4 } from 'uuid'
import Navbar from '@/components/Navbar'
import { createClient } from '@/lib/supabase/client'
import type { Profile, Song, DetectedWord, ProcessingStatus, MuteType } from '@/types'

// Extends DetectedWord with a client-side id for the review UI
type ReviewWord = DetectedWord & { id: string }

interface Props {
  profile: Profile | null
  initialSongs: Song[]
  userEmail: string
}

const STAGE_LABELS: Record<ProcessingStatus['stage'], string> = {
  uploading: 'Uploading your file...',
  analyzing: 'AI is analyzing your song...',
  processing: 'Processing audio...',
  complete: 'Done!',
  failed: 'Something went wrong.',
}

const PROCESS_TIMEOUT_MS = 6 * 60 * 1000

/** Parse "1:23", "1:23.4", or plain seconds "83.5" into seconds. */
function parseTimeInput(input: string): number {
  const clean = input.trim()
  const m = clean.match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2])
  return parseFloat(clean)
}

function censorDisplay(word: string): string {
  if (word.length <= 1) return '*'
  return word[0] + '*'.repeat(Math.max(1, word.length - 2)) + word[word.length - 1]
}

export default function DashboardClient({ profile, initialSongs, userEmail }: Props) {
  const [songs, setSongs] = useState<Song[]>(initialSongs)
  const [status, setStatus] = useState<ProcessingStatus | null>(null)
  const [muteType, setMuteType] = useState<MuteType>('mute')
  const [result, setResult] = useState<{
    cleanUrl: string
    wordsDetected: DetectedWord[]
    songId: string
    detectionMethod: 'lyrics' | 'ai'
  } | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)

  // ── Review state ────────────────────────────────────────────────────────────
  const [pendingReview, setPendingReview] = useState<{
    songId: string
    originalUrl: string
    originalFilename: string
    words: ReviewWord[]
    detectionMethod: 'lyrics' | 'ai'
  } | null>(null)
  const [isReprocessing, setIsReprocessing] = useState(false)
  const [newWordTime, setNewWordTime] = useState('')
  const [newWordText, setNewWordText] = useState('')

  // ── Manual lyrics state ─────────────────────────────────────────────────────
  const [lyricsInput, setLyricsInput] = useState('')
  const [lyricsExpanded, setLyricsExpanded] = useState(false)

  const FREE_LIMIT = 3
  const isPro = profile?.plan === 'pro'
  const usedThisMonth = profile?.songs_processed_this_month ?? 0
  const atLimit = !isPro && usedThisMonth >= FREE_LIMIT

  // ── Upload + initial processing ─────────────────────────────────────────────
  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0]
      if (!file) return
      if (atLimit) {
        toast.error("You've reached your free limit. Upgrade to Pro!")
        return
      }

      setResult(null)
      setPendingReview(null)
      setIsProcessing(true)

      const supabase = createClient()
      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), PROCESS_TIMEOUT_MS)

      try {
        const {
          data: { user },
        } = await supabase.auth.getUser()

        if (!user) throw new Error('You must be logged in. Please refresh the page.')

        setStatus({ stage: 'uploading', message: STAGE_LABELS.uploading, progress: 10 })

        const songId = uuidv4()
        const ext = file.name.toLowerCase().endsWith('.wav') ? '.wav' : '.mp3'
        const storagePath = `originals/${user.id}/${songId}${ext}`

        const { error: uploadError } = await supabase.storage
          .from('audio')
          .upload(storagePath, file, {
            contentType: file.type || 'audio/mpeg',
            upsert: false,
          })

        if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`)

        const { data: urlData } = supabase.storage.from('audio').getPublicUrl(storagePath)
        const originalUrl = urlData.publicUrl

        setStatus({ stage: 'analyzing', message: STAGE_LABELS.analyzing, progress: 30 })

        const res = await fetch('/api/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            songId,
            originalUrl,
            originalFilename: file.name,
            muteType,
            manualLyrics: lyricsInput.trim() || undefined,
          }),
          signal: abortController.signal,
        })

        setStatus({ stage: 'processing', message: STAGE_LABELS.processing, progress: 80 })

        const data = await res.json()

        if (!res.ok) {
          if (data.upgrade) {
            toast.error('Monthly limit reached. Upgrade to Pro for unlimited songs.')
          } else {
            toast.error(data.error || 'Processing failed. Please try again.')
          }
          setStatus({ stage: 'failed', message: data.error || 'Processing failed', progress: 0 })
          return
        }

        // Hand off to the review screen instead of going straight to download
        setStatus({ stage: 'complete', message: STAGE_LABELS.complete, progress: 100 })
        const words: ReviewWord[] = (data.wordsDetected || []).map((w: DetectedWord) => ({
          ...w,
          id: uuidv4(),
        }))
        setPendingReview({
          songId: data.songId,
          originalUrl: data.originalUrl,
          originalFilename: file.name,
          words,
          detectionMethod: data.detectionMethod ?? 'ai',
        })

        const wc = words.length
        toast.success(
          wc === 0
            ? 'No profanity detected!'
            : `Found ${wc} word${wc !== 1 ? 's' : ''} — review the list below.`
        )
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          toast.error('Processing timed out. Please try again.')
          setStatus({ stage: 'failed', message: 'Timed out — please try again', progress: 0 })
        } else {
          const message = err instanceof Error ? err.message : 'An unexpected error occurred.'
          console.error('[onDrop]', err)
          toast.error(message)
          setStatus({ stage: 'failed', message, progress: 0 })
        }
      } finally {
        clearTimeout(timeoutId)
        setIsProcessing(false)
      }
    },
    [muteType, atLimit, lyricsInput]
  )

  // ── Review actions ──────────────────────────────────────────────────────────
  const nudgeWord = (id: string, delta: number) => {
    setPendingReview((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        words: prev.words.map((w) =>
          w.id === id
            ? { ...w, start: Math.max(0, w.start + delta), end: Math.max(0, w.end + delta) }
            : w
        ),
      }
    })
  }

  const removeWord = (id: string) => {
    setPendingReview((prev) => {
      if (!prev) return prev
      return { ...prev, words: prev.words.filter((w) => w.id !== id) }
    })
  }

  const addWord = () => {
    if (!pendingReview || !newWordText.trim()) return
    const t = parseTimeInput(newWordTime)
    if (isNaN(t)) {
      toast.error('Enter a valid time like 1:23 or 83')
      return
    }
    const newWord: ReviewWord = {
      id: uuidv4(),
      word: newWordText.trim().toLowerCase(),
      start: Math.max(0, t - 1.0),
      end: t + 1.0,
      mute_type: muteType,
    }
    setPendingReview((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        words: [...prev.words, newWord].sort((a, b) => a.start - b.start),
      }
    })
    setNewWordTime('')
    setNewWordText('')
  }

  const handleConfirm = async () => {
    if (!pendingReview) return
    setIsReprocessing(true)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), PROCESS_TIMEOUT_MS)

    try {
      const res = await fetch('/api/reprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          songId: pendingReview.songId,
          originalUrl: pendingReview.originalUrl,
          originalFilename: pendingReview.originalFilename,
          // strip the client-side id before sending
          wordsDetected: pendingReview.words.map(({ id: _id, ...w }) => w),
        }),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)
      const data = await res.json()

      if (!res.ok) {
        toast.error(data.error || 'Processing failed. Please try again.')
        return
      }

      const finalWords = pendingReview.words.map(({ id: _id, ...w }) => w)
      setResult({
        cleanUrl: data.cleanUrl,
        wordsDetected: finalWords,
        songId: pendingReview.songId,
        detectionMethod: pendingReview.detectionMethod,
      })
      setPendingReview(null)

      const refreshRes = await fetch('/api/songs')
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json()
        setSongs(refreshData.songs || [])
      }

      const wc = finalWords.length
      toast.success(
        wc === 0
          ? 'No profanity — your song is already clean!'
          : `Done! ${wc} word${wc !== 1 ? 's' : ''} muted.`
      )
    } catch (err) {
      clearTimeout(timeoutId)
      if (err instanceof Error && err.name === 'AbortError') {
        toast.error('Processing timed out. Please try again.')
      } else {
        toast.error(err instanceof Error ? err.message : 'Processing failed.')
      }
    } finally {
      setIsReprocessing(false)
    }
  }

  // ── Dropzone ─────────────────────────────────────────────────────────────────
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'audio/mpeg': ['.mp3'],
      'audio/wav': ['.wav'],
      'audio/wave': ['.wav'],
    },
    maxSize: 50 * 1024 * 1024,
    multiple: false,
    disabled: isProcessing || atLimit || !!pendingReview,
    onDropRejected: (files) => {
      const err = files[0]?.errors[0]
      if (err?.code === 'file-too-large') toast.error('File too large. Max 50MB.')
      else if (err?.code === 'file-invalid-type')
        toast.error('Only MP3 and WAV files are supported.')
      else toast.error('Invalid file.')
    },
  })

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function formatTime(seconds: number) {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0F1629]">
      <Navbar />

      <div className="max-w-4xl mx-auto px-4 pt-24 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white">Dashboard</h1>
            <p className="text-white/50 mt-1">{userEmail}</p>
          </div>

          <div className="text-right">
            {isPro ? (
              <span className="inline-flex items-center gap-1.5 bg-violet-600/20 text-violet-300 text-sm px-3 py-1.5 rounded-full border border-violet-500/30">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                Pro — Unlimited
              </span>
            ) : (
              <div>
                <p className="text-white/50 text-sm mb-1">
                  {usedThisMonth} of {FREE_LIMIT} free songs used this month
                </p>
                <div className="w-32 h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-violet-600 rounded-full transition-all"
                    style={{ width: `${Math.min((usedThisMonth / FREE_LIMIT) * 100, 100)}%` }}
                  />
                </div>
                {atLimit && (
                  <Link
                    href="/pricing"
                    className="text-xs text-violet-400 hover:text-violet-300 mt-1 block"
                  >
                    Upgrade to Pro →
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Upload zone — hidden while reviewing */}
        {!pendingReview && (
          <div className="mb-8">
            <div className="flex items-center gap-4 mb-4">
              <h2 className="text-white font-semibold">Clean a new song</h2>
              <div className="flex bg-white/10 rounded-lg p-1 gap-1">
                {(['mute', 'bleep'] as MuteType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => setMuteType(type)}
                    disabled={isProcessing}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                      muteType === type
                        ? 'bg-violet-600 text-white'
                        : 'text-white/50 hover:text-white'
                    }`}
                  >
                    {type === 'mute' ? '🔇 Mute' : '📡 Bleep'}
                  </button>
                ))}
              </div>
            </div>

            {/* Dropzone */}
            <div
              {...getRootProps()}
              className={`relative border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-200 ${
                atLimit
                  ? 'border-white/10 opacity-50 cursor-not-allowed'
                  : isDragActive
                  ? 'border-violet-500 bg-violet-600/10 dropzone-active'
                  : isProcessing
                  ? 'border-violet-500/30 bg-violet-600/5 cursor-wait'
                  : 'border-white/20 hover:border-violet-500/50 hover:bg-violet-600/5'
              }`}
            >
              <input {...getInputProps()} />

              {isProcessing ? (
                <div>
                  <div className="w-16 h-16 rounded-2xl bg-violet-600/20 flex items-center justify-center mx-auto mb-4">
                    <div className="w-8 h-8 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                  <p className="text-white font-medium mb-2">{status?.message}</p>
                  <div className="max-w-xs mx-auto">
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full progress-shimmer rounded-full transition-all duration-1000"
                        style={{ width: `${status?.progress ?? 0}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-white/30 mt-1">
                      <span>Uploading</span>
                      <span>Analyzing</span>
                      <span>Processing</span>
                      <span>Ready</span>
                    </div>
                  </div>
                  <p className="text-white/30 text-xs mt-3">
                    This can take 1–3 minutes depending on song length
                  </p>
                </div>
              ) : status?.stage === 'failed' ? (
                <div>
                  <div className="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      className="w-8 h-8 text-red-400"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                      />
                    </svg>
                  </div>
                  <p className="text-red-400 font-medium mb-1">Processing failed</p>
                  <p className="text-white/40 text-sm mb-4">{status.message}</p>
                  <button
                    onClick={() => setStatus(null)}
                    className="text-violet-400 text-sm hover:text-violet-300 underline"
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <div>
                  <div className="w-16 h-16 rounded-2xl bg-violet-600/20 flex items-center justify-center mx-auto mb-4">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      className="w-8 h-8 text-violet-400"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                      />
                    </svg>
                  </div>
                  {atLimit ? (
                    <>
                      <p className="text-white font-medium mb-1">Monthly limit reached</p>
                      <p className="text-white/40 text-sm">
                        <Link href="/pricing" className="text-violet-400 hover:underline">
                          Upgrade to Pro
                        </Link>{' '}
                        for unlimited songs
                      </p>
                    </>
                  ) : isDragActive ? (
                    <p className="text-violet-300 font-medium">Drop your song here!</p>
                  ) : (
                    <>
                      <p className="text-white font-medium mb-1">Drag & drop your song here</p>
                      <p className="text-white/40 text-sm">
                        or <span className="text-violet-400">click to browse</span> — MP3 or WAV,
                        up to 50MB
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Manual lyrics input — expandable, hidden while processing */}
            {!isProcessing && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setLyricsExpanded(!lyricsExpanded)}
                  className="text-xs text-white/30 hover:text-white/50 flex items-center gap-1.5 transition-colors"
                >
                  <svg
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className={`w-3 h-3 transition-transform ${lyricsExpanded ? 'rotate-90' : ''}`}
                  >
                    <path
                      fillRule="evenodd"
                      d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Paste lyrics manually (bypasses auto-detection)
                </button>

                {lyricsExpanded && (
                  <div className="mt-2">
                    <textarea
                      value={lyricsInput}
                      onChange={(e) => setLyricsInput(e.target.value)}
                      placeholder={
                        'LRC format (best — gives exact timestamps):\n[00:12.34] She\'s a bad bitch\n[00:15.00] Fuck the police\n\nOr plain text (word detection only, no timestamps):\nShe\'s a bad bitch\nFuck the police'
                      }
                      rows={5}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white/70 text-xs font-mono resize-none focus:outline-none focus:border-violet-500/50 placeholder:text-white/20"
                    />
                    <p className="text-xs text-white/25 mt-1">
                      LRC with timestamps is most accurate. If left blank, LRCLIB is queried first,
                      then AssemblyAI.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Review screen — shown between processing and download */}
        {pendingReview && (
          <div className="mb-8 glass rounded-2xl p-6 animate-fade-in">
            {/* Header row */}
            <div className="flex items-start justify-between mb-5">
              <div>
                <h3 className="text-white font-semibold flex items-center gap-2">
                  Review detected words
                  {pendingReview.detectionMethod === 'lyrics' ? (
                    <span className="text-xs font-normal bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                      Lyrics-assisted
                    </span>
                  ) : (
                    <span className="text-xs font-normal bg-blue-500/20 text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded-full">
                      AI detection
                    </span>
                  )}
                </h3>
                <p className="text-white/40 text-sm mt-1">
                  Nudge timing, remove false positives, or add missed words — then process.
                </p>
              </div>

              <button
                onClick={handleConfirm}
                disabled={isReprocessing}
                className="shrink-0 bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white font-medium px-5 py-2.5 rounded-xl text-sm transition-colors flex items-center gap-2 ml-4"
              >
                {isReprocessing ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Processing…
                  </>
                ) : (
                  'Process audio →'
                )}
              </button>
            </div>

            {/* Word list */}
            {pendingReview.words.length === 0 ? (
              <div className="text-center py-6 text-white/40 text-sm">
                No words to mute — the song appears clean.{' '}
                <button
                  onClick={handleConfirm}
                  disabled={isReprocessing}
                  className="text-violet-400 hover:text-violet-300 underline"
                >
                  Confirm and download original
                </button>
              </div>
            ) : (
              <div className="space-y-2 mb-5">
                {pendingReview.words.map((w) => (
                  <div
                    key={w.id}
                    className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2"
                  >
                    {/* Censored word */}
                    <span className="text-red-400 font-mono text-sm font-bold w-20 shrink-0">
                      {censorDisplay(w.word)}
                    </span>

                    {/* Timestamp range */}
                    <span className="text-white/30 text-xs font-mono w-28 shrink-0">
                      {formatTime(w.start)} → {formatTime(w.end)}
                    </span>

                    {/* Nudge + remove */}
                    <div className="flex items-center gap-1 ml-auto">
                      <button
                        onClick={() => nudgeWord(w.id, -0.5)}
                        title="Shift 0.5s earlier"
                        className="text-xs bg-white/10 hover:bg-white/20 text-white/60 hover:text-white px-2 py-1 rounded transition-colors"
                      >
                        ← 0.5s
                      </button>
                      <button
                        onClick={() => nudgeWord(w.id, 0.5)}
                        title="Shift 0.5s later"
                        className="text-xs bg-white/10 hover:bg-white/20 text-white/60 hover:text-white px-2 py-1 rounded transition-colors"
                      >
                        0.5s →
                      </button>
                      <button
                        onClick={() => removeWord(w.id)}
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
            <div className="border-t border-white/10 pt-4">
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
                Timestamp format: 1:23 or 83 (seconds). Window is ±1s around the timestamp.
              </p>
            </div>
          </div>
        )}

        {/* Download result */}
        {result && (
          <div className="mb-8 glass rounded-2xl p-6 animate-fade-in">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold flex items-center gap-2">
                <span className="w-2 h-2 bg-green-400 rounded-full" />
                Processing complete
                {result.detectionMethod === 'lyrics' ? (
                  <span className="text-xs font-normal bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                    Lyrics-assisted
                  </span>
                ) : (
                  <span className="text-xs font-normal bg-blue-500/20 text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded-full">
                    AI detection
                  </span>
                )}
              </h3>
              <a
                href={result.cleanUrl}
                download
                className="bg-violet-600 hover:bg-violet-700 text-white font-medium px-5 py-2.5 rounded-xl text-sm transition-colors flex items-center gap-2"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path
                    fillRule="evenodd"
                    d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
                Download clean version
              </a>
            </div>

            {result.wordsDetected.length === 0 ? (
              <p className="text-white/50 text-sm">
                No profanity detected — your song is already clean!
              </p>
            ) : (
              <>
                <p className="text-white/50 text-sm mb-3">
                  {result.wordsDetected.length} word
                  {result.wordsDetected.length !== 1 ? 's' : ''} detected and{' '}
                  {muteType === 'mute' ? 'muted' : 'bleeped'}:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {result.wordsDetected.map((w, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 bg-white/5 rounded-lg px-4 py-2.5"
                    >
                      <span className="text-red-400 font-mono text-sm font-bold">
                        {censorDisplay(w.word)}
                      </span>
                      <span className="text-white/40 text-xs">{formatTime(w.start)}</span>
                      <span className="ml-auto text-xs bg-violet-600/30 text-violet-300 px-2 py-0.5 rounded capitalize">
                        {w.mute_type}d
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Song History */}
        {songs.length > 0 && (
          <div>
            <h2 className="text-white font-semibold mb-4">Song history</h2>
            <div className="space-y-3">
              {songs.map((song) => (
                <div key={song.id} className="glass rounded-xl p-4 flex items-center gap-4">
                  <div className="w-10 h-10 bg-violet-600/20 rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-violet-400">
                      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                    </svg>
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">
                      {song.original_filename}
                    </p>
                    <p className="text-white/40 text-xs">
                      {formatDate(song.created_at)} ·{' '}
                      {song.status === 'complete'
                        ? `${(song.words_detected as DetectedWord[])?.length ?? 0} words removed`
                        : song.status}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    {song.status === 'complete' ? (
                      <>
                        <span className="text-xs text-green-400 bg-green-500/10 px-2 py-1 rounded-full">
                          Ready
                        </span>
                        {song.clean_url && (
                          <a
                            href={song.clean_url}
                            download
                            className="text-violet-400 hover:text-violet-300 transition-colors"
                            title="Download"
                          >
                            <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                              <path
                                fillRule="evenodd"
                                d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
                                clipRule="evenodd"
                              />
                            </svg>
                          </a>
                        )}
                      </>
                    ) : song.status === 'processing' ? (
                      <span className="text-xs text-yellow-400 bg-yellow-500/10 px-2 py-1 rounded-full">
                        Processing
                      </span>
                    ) : (
                      <span className="text-xs text-red-400 bg-red-500/10 px-2 py-1 rounded-full">
                        Failed
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {songs.length === 0 && !isProcessing && !result && !pendingReview && (
          <div className="text-center py-12 text-white/30">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              className="w-12 h-12 mx-auto mb-3 opacity-50"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z"
              />
            </svg>
            <p className="text-sm">No songs yet. Upload one above to get started.</p>
          </div>
        )}
      </div>
    </div>
  )
}
