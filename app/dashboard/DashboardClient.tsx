'use client'

import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { v4 as uuidv4 } from 'uuid'
import dynamic from 'next/dynamic'
import Navbar from '@/components/Navbar'
import { createClient } from '@/lib/supabase/client'
import type { Profile, Song, DetectedWord, ProcessingStatus, MuteType } from '@/types'
import type { ReviewWord } from '@/components/WaveformReview'

const WaveformReview = dynamic(() => import('@/components/WaveformReview'), { ssr: false })

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

  // ── Manual lyrics state ─────────────────────────────────────────────────────
  const [lyricsInput, setLyricsInput] = useState('')
  const [lyricsExpanded, setLyricsExpanded] = useState(false)

  // ── Import tab state ─────────────────────────────────────────────────────────
  const [uploadTab, setUploadTab] = useState<'file' | 'soundcloud'>('file')
  const [soundcloudUrl, setSoundcloudUrl] = useState('')
  const [isSoundcloudImporting, setIsSoundcloudImporting] = useState(false)
  const [soundcloudError, setSoundcloudError] = useState<string | null>(null)
  const [howToExpanded, setHowToExpanded] = useState(false)
  const [scSearchQuery, setScSearchQuery] = useState('')
  const [isScSearching, setIsScSearching] = useState(false)

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

  // ── SoundCloud search ────────────────────────────────────────────────────────
  const handleSoundcloudSearch = async () => {
    const query = scSearchQuery.trim()
    if (!query || isScSearching) return

    setSoundcloudError(null)
    setIsScSearching(true)
    try {
      const res = await fetch('/api/soundcloud/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSoundcloudError(data.error || 'Search failed. Please try again.')
        return
      }
      setSoundcloudUrl(data.url)
      toast.success(
        data.artist ? `Found "${data.title}" by ${data.artist}` : `Found "${data.title}"`
      )
    } catch (err) {
      setSoundcloudError(err instanceof Error ? err.message : 'Search failed.')
    } finally {
      setIsScSearching(false)
    }
  }

  // ── SoundCloud import ────────────────────────────────────────────────────────
  const handleSoundcloudImport = async () => {
    const url = soundcloudUrl.trim()
    if (!url) return
    if (atLimit) { toast.error("You've reached your free limit. Upgrade to Pro!"); return }

    setResult(null)
    setPendingReview(null)
    setSoundcloudError(null)
    setIsSoundcloudImporting(true)

    const abortController = new AbortController()
    const timeoutId = setTimeout(() => abortController.abort(), PROCESS_TIMEOUT_MS)

    try {
      setStatus({ stage: 'uploading', message: 'Downloading SoundCloud audio…', progress: 15 })
      const scRes = await fetch('/api/soundcloud', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ soundcloudUrl: url }),
        signal: abortController.signal,
      })
      const scData = await scRes.json()
      if (!scRes.ok) {
        setSoundcloudError(scData.error || 'Failed to import SoundCloud track')
        setStatus(null)
        return
      }

      setIsSoundcloudImporting(false)
      setIsProcessing(true)
      setStatus({ stage: 'analyzing', message: STAGE_LABELS.analyzing, progress: 30 })

      const processRes = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          songId: scData.songId,
          originalUrl: scData.originalUrl,
          originalFilename: scData.originalFilename,
          muteType,
          manualLyrics: lyricsInput.trim() || undefined,
        }),
        signal: abortController.signal,
      })

      setStatus({ stage: 'processing', message: STAGE_LABELS.processing, progress: 80 })
      const data = await processRes.json()

      if (!processRes.ok) {
        if (data.upgrade) {
          toast.error('Monthly limit reached. Upgrade to Pro for unlimited songs.')
        } else {
          toast.error(data.error || 'Processing failed. Please try again.')
        }
        setStatus({ stage: 'failed', message: data.error || 'Processing failed', progress: 0 })
        return
      }

      setStatus({ stage: 'complete', message: STAGE_LABELS.complete, progress: 100 })
      const words: ReviewWord[] = (data.wordsDetected || []).map((w: DetectedWord) => ({
        ...w,
        id: uuidv4(),
      }))
      setPendingReview({
        songId: scData.songId,
        originalUrl: scData.originalUrl,
        originalFilename: scData.originalFilename,
        words,
        detectionMethod: data.detectionMethod ?? 'ai',
      })
      setSoundcloudUrl('')

      const wc = words.length
      toast.success(
        wc === 0
          ? 'No profanity detected!'
          : `Found ${wc} word${wc !== 1 ? 's' : ''} — review the list below.`
      )
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        toast.error('Import timed out. Please try again.')
        setStatus({ stage: 'failed', message: 'Timed out — please try again', progress: 0 })
      } else {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred.'
        toast.error(message)
        setStatus({ stage: 'failed', message, progress: 0 })
      }
    } finally {
      clearTimeout(timeoutId)
      setIsSoundcloudImporting(false)
      setIsProcessing(false)
    }
  }

  // ── Review actions ──────────────────────────────────────────────────────────
  const handleWordsChange = useCallback((newWords: ReviewWord[]) => {
    setPendingReview((prev) => prev ? { ...prev, words: newWords } : prev)
  }, [])

  const handleConfirm = async () => {
    if (!pendingReview) return
    setIsReprocessing(true)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), PROCESS_TIMEOUT_MS)

    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const wordsToSend = pendingReview.words.map(({ id: _id, ...w }) => w)
      console.log('[handleConfirm] Sending to /api/reprocess:', JSON.stringify(wordsToSend))
      const res = await fetch('/api/reprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          songId: pendingReview.songId,
          originalUrl: pendingReview.originalUrl,
          originalFilename: pendingReview.originalFilename,
          wordsDetected: wordsToSend,
        }),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)
      const data = await res.json()

      if (!res.ok) {
        toast.error(data.error || 'Processing failed. Please try again.')
        return
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

  function timeAgo(dateStr: string): string {
    const diffMs = Date.now() - new Date(dateStr).getTime()
    const m = Math.floor(diffMs / 60_000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    const d = Math.floor(h / 24)
    if (d < 30) return `${d}d ago`
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
                    disabled={isProcessing || isSoundcloudImporting}
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

            {/* Processing / loading state — shared across file and SoundCloud imports */}
            {(isProcessing || isSoundcloudImporting) ? (
              <div className="border-2 border-violet-500/30 bg-violet-600/5 rounded-2xl p-12 text-center">
                <div className="w-16 h-16 rounded-2xl bg-violet-600/20 flex items-center justify-center mx-auto mb-4">
                  <div className="w-8 h-8 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
                </div>
                <p className="text-white font-medium mb-2">{status?.message ?? 'Importing…'}</p>
                <div className="max-w-xs mx-auto">
                  <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full progress-shimmer rounded-full transition-all duration-1000"
                      style={{ width: `${status?.progress ?? 5}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-white/30 mt-1">
                    <span>Downloading</span>
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
              <div className="border-2 border-dashed border-red-500/20 rounded-2xl p-12 text-center">
                <div className="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center mx-auto mb-4">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-8 h-8 text-red-400">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
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
              <>
                {/* Tab switcher */}
                <div className="flex mb-3 bg-white/5 border border-white/10 rounded-xl p-1 gap-1">
                  <button
                    onClick={() => { setUploadTab('file'); setSoundcloudError(null) }}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                      uploadTab === 'file' ? 'bg-violet-600 text-white shadow' : 'text-white/40 hover:text-white/70'
                    }`}
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                      <path d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" />
                    </svg>
                    Upload File
                  </button>
                  <button
                    onClick={() => { setUploadTab('soundcloud'); setSoundcloudError(null) }}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                      uploadTab === 'soundcloud' ? 'bg-violet-600 text-white shadow' : 'text-white/40 hover:text-white/70'
                    }`}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                      <path d="M1.175 12.225c-.059 0-.106.045-.116.112l-.479 3.025.479 2.978c.01.067.057.112.116.112.059 0 .107-.045.115-.112l.544-2.978-.544-3.025c-.008-.067-.056-.112-.115-.112zm1.31-.544c-.069 0-.124.054-.132.122l-.416 3.569.416 3.459c.008.069.063.122.132.122.069 0 .124-.053.131-.122l.474-3.459-.474-3.569c-.007-.068-.062-.122-.131-.122zm1.35-.248c-.078 0-.142.062-.149.139l-.353 3.817.353 3.7c.007.077.071.139.149.139.078 0 .143-.062.149-.139l.4-3.7-.4-3.817c-.006-.077-.071-.139-.149-.139zm1.395.057c-.088 0-.16.07-.165.158l-.289 3.76.289 3.633c.005.088.077.158.165.158.089 0 .16-.07.165-.158l.328-3.633-.328-3.76c-.005-.088-.076-.158-.165-.158zm1.42-.156c-.097 0-.177.078-.181.174l-.226 3.916.226 3.561c.004.096.084.174.181.174.098 0 .177-.078.18-.174l.257-3.561-.257-3.916c-.003-.096-.082-.174-.18-.174zm1.448.091c-.107 0-.195.086-.198.193l-.162 3.825.162 3.489c.003.107.091.193.198.193.108 0 .196-.086.197-.193l.184-3.489-.184-3.825c-.001-.107-.089-.193-.197-.193zm1.475-.07c-.116 0-.211.093-.213.209l-.099 3.895.099 3.417c.002.116.097.209.213.209.117 0 .211-.093.213-.209l.112-3.417-.112-3.895c-.002-.116-.096-.209-.213-.209zm1.503-.116c-.126 0-.229.101-.229.226l-.036 4.011.036 3.345c0 .125.103.226.229.226.127 0 .229-.101.229-.226l.041-3.345-.041-4.011c0-.125-.102-.226-.229-.226zm1.529.045c-.135 0-.245.109-.245.243v3.966l.245 3.273c0 .134.11.243.245.243.136 0 .246-.109.245-.243l.278-3.273-.278-3.966c0-.134-.109-.243-.245-.243zm1.555-.215c-.145 0-.262.116-.262.26l0 .001-.204 4.181.204 3.201c0 .144.117.26.262.26.146 0 .263-.116.262-.26l.232-3.201-.232-4.181c0-.144-.116-.261-.262-.261zm1.58.045c-.154 0-.279.124-.279.277l-.14 4.136.14 3.129c0 .153.125.277.279.277.155 0 .28-.124.279-.277l.159-3.129-.159-4.136c0-.153-.124-.277-.279-.277zm4.098-1.127c-.201-.077-.412-.116-.627-.115-.229 0-.45.041-.659.118-.047-2.404-1.999-4.345-4.408-4.345-1.064 0-2.038.382-2.796 1.013-.29.238-.368.518-.372.793v8.619c.004.283.232.513.516.524h8.346c.57 0 1.034-.458 1.034-1.024v-3.458c0-1.204-.808-2.22-2.034-2.125z" />
                    </svg>
                    SoundCloud Link
                  </button>
                </div>

                {/* File upload tab */}
                {uploadTab === 'file' && (
                  <>
                  <div
                    {...getRootProps()}
                    className={`relative border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-200 ${
                      atLimit
                        ? 'border-white/10 opacity-50 cursor-not-allowed'
                        : isDragActive
                        ? 'border-violet-500 bg-violet-600/10 dropzone-active'
                        : 'border-white/20 hover:border-violet-500/50 hover:bg-violet-600/5'
                    }`}
                  >
                    <input {...getInputProps()} />
                    <div>
                      <div className="w-16 h-16 rounded-2xl bg-violet-600/20 flex items-center justify-center mx-auto mb-4">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-8 h-8 text-violet-400">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                        </svg>
                      </div>
                      {atLimit ? (
                        <>
                          <p className="text-white font-medium mb-1">Monthly limit reached</p>
                          <p className="text-white/40 text-sm">
                            <Link href="/pricing" className="text-violet-400 hover:underline">Upgrade to Pro</Link>{' '}for unlimited songs
                          </p>
                        </>
                      ) : isDragActive ? (
                        <p className="text-violet-300 font-medium">Drop your song here!</p>
                      ) : (
                        <>
                          <p className="text-white font-medium mb-1">Drag &amp; drop your song here</p>
                          <p className="text-white/40 text-sm">
                            or <span className="text-violet-400">click to browse</span> — MP3 or WAV, up to 50MB
                          </p>
                        </>
                      )}
                    </div>
                  </div>

                  {/* How to get your MP3 guide */}
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => setHowToExpanded(!howToExpanded)}
                      className="text-xs text-white/30 hover:text-white/50 flex items-center gap-1.5 transition-colors"
                    >
                      <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className={`w-3 h-3 transition-transform ${howToExpanded ? 'rotate-90' : ''}`}
                      >
                        <path
                          fillRule="evenodd"
                          d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Don&apos;t have the MP3 file? Here&apos;s how to get it
                    </button>

                    {howToExpanded && (
                      <div className="mt-3 bg-white/5 border border-white/10 rounded-xl p-4 space-y-4 text-xs text-white/60">
                        {/* Tip box */}
                        <div className="bg-violet-600/10 border border-violet-500/20 rounded-lg px-3 py-2.5 text-violet-200/80">
                          <span className="font-semibold">Tip:</span> Leave the filename as-is after downloading. Bleeep reads it to find your song&apos;s lyrics automatically &mdash; the format &ldquo;Artist - Song Name.mp3&rdquo; works best.
                        </div>

                        {/* Method 1: cnvmp3.com */}
                        <div>
                          <p className="font-semibold text-white/70 mb-1.5">Method 1 &mdash; Convert from YouTube (free website)</p>
                          <ol className="list-decimal list-inside space-y-1 pl-1">
                            <li>Go to <span className="text-violet-300 font-mono">cnvmp3.com/v54</span> in your browser</li>
                            <li>Find the song on YouTube and copy its URL from the address bar</li>
                            <li>Paste the URL into the box on cnvmp3.com and click <span className="text-white/80">Convert</span></li>
                            <li>Wait a few seconds for it to process</li>
                            <li>Click <span className="text-white/80">Download</span> to save the MP3</li>
                            <li>Come back here and upload that file &mdash; done!</li>
                          </ol>
                        </div>

                        {/* Method 2: Already have it */}
                        <div>
                          <p className="font-semibold text-white/70 mb-1.5">Method 2 &mdash; Already own the song</p>
                          <ul className="space-y-1 pl-1">
                            <li><span className="text-white/80">iPhone:</span> Open the <span className="text-white/80">Files</span> app, find the MP3, then share it to your computer or upload directly</li>
                            <li><span className="text-white/80">Mac:</span> Open <span className="text-white/80">Music</span> (iTunes), right-click the track &rarr; <span className="text-white/80">Show in Finder</span>, then drag the file here</li>
                            <li><span className="text-white/80">PC:</span> Open <span className="text-white/80">iTunes</span>, right-click the track &rarr; <span className="text-white/80">Show in Windows Explorer</span>, then drag the file here</li>
                          </ul>
                        </div>

                        {/* Method 3: SoundCloud */}
                        <div>
                          <p className="font-semibold text-white/70 mb-1">Method 3 &mdash; Import from SoundCloud</p>
                          <p>
                            If the song is on SoundCloud, use the{' '}
                            <button
                              type="button"
                              onClick={() => { setUploadTab('soundcloud'); setHowToExpanded(false) }}
                              className="text-violet-400 hover:text-violet-300 underline"
                            >
                              SoundCloud Link
                            </button>
                            {' '}tab above &mdash; no download needed.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                  </>
                )}

                {/* SoundCloud import tab */}
                {uploadTab === 'soundcloud' && (
                  <div className="border-2 border-dashed border-white/20 hover:border-white/30 rounded-2xl p-10 transition-colors">
                    <div className="max-w-md mx-auto text-center">
                      <div className="w-16 h-16 rounded-2xl bg-orange-500/10 flex items-center justify-center mx-auto mb-4">
                        <svg viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-orange-400">
                          <path d="M1.175 12.225c-.059 0-.106.045-.116.112l-.479 3.025.479 2.978c.01.067.057.112.116.112.059 0 .107-.045.115-.112l.544-2.978-.544-3.025c-.008-.067-.056-.112-.115-.112zm1.31-.544c-.069 0-.124.054-.132.122l-.416 3.569.416 3.459c.008.069.063.122.132.122.069 0 .124-.053.131-.122l.474-3.459-.474-3.569c-.007-.068-.062-.122-.131-.122zm1.35-.248c-.078 0-.142.062-.149.139l-.353 3.817.353 3.7c.007.077.071.139.149.139.078 0 .143-.062.149-.139l.4-3.7-.4-3.817c-.006-.077-.071-.139-.149-.139zm1.395.057c-.088 0-.16.07-.165.158l-.289 3.76.289 3.633c.005.088.077.158.165.158.089 0 .16-.07.165-.158l.328-3.633-.328-3.76c-.005-.088-.076-.158-.165-.158zm1.42-.156c-.097 0-.177.078-.181.174l-.226 3.916.226 3.561c.004.096.084.174.181.174.098 0 .177-.078.18-.174l.257-3.561-.257-3.916c-.003-.096-.082-.174-.18-.174zm1.448.091c-.107 0-.195.086-.198.193l-.162 3.825.162 3.489c.003.107.091.193.198.193.108 0 .196-.086.197-.193l.184-3.489-.184-3.825c-.001-.107-.089-.193-.197-.193zm1.475-.07c-.116 0-.211.093-.213.209l-.099 3.895.099 3.417c.002.116.097.209.213.209.117 0 .211-.093.213-.209l.112-3.417-.112-3.895c-.002-.116-.096-.209-.213-.209zm1.503-.116c-.126 0-.229.101-.229.226l-.036 4.011.036 3.345c0 .125.103.226.229.226.127 0 .229-.101.229-.226l.041-3.345-.041-4.011c0-.125-.102-.226-.229-.226zm1.529.045c-.135 0-.245.109-.245.243v3.966l.245 3.273c0 .134.11.243.245.243.136 0 .246-.109.245-.243l.278-3.273-.278-3.966c0-.134-.109-.243-.245-.243zm1.555-.215c-.145 0-.262.116-.262.26l0 .001-.204 4.181.204 3.201c0 .144.117.26.262.26.146 0 .263-.116.262-.26l.232-3.201-.232-4.181c0-.144-.116-.261-.262-.261zm1.58.045c-.154 0-.279.124-.279.277l-.14 4.136.14 3.129c0 .153.125.277.279.277.155 0 .28-.124.279-.277l.159-3.129-.159-4.136c0-.153-.124-.277-.279-.277zm4.098-1.127c-.201-.077-.412-.116-.627-.115-.229 0-.45.041-.659.118-.047-2.404-1.999-4.345-4.408-4.345-1.064 0-2.038.382-2.796 1.013-.29.238-.368.518-.372.793v8.619c.004.283.232.513.516.524h8.346c.57 0 1.034-.458 1.034-1.024v-3.458c0-1.204-.808-2.22-2.034-2.125z" />
                        </svg>
                      </div>
                      {atLimit ? (
                        <>
                          <p className="text-white font-medium mb-1">Monthly limit reached</p>
                          <p className="text-white/40 text-sm">
                            <Link href="/pricing" className="text-violet-400 hover:underline">Upgrade to Pro</Link>{' '}for unlimited songs
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-white font-medium mb-1">Import from SoundCloud</p>
                          <p className="text-white/40 text-sm mb-4">
                            Search for a song or paste a SoundCloud track link
                          </p>
                          <div className="flex gap-2 mb-3">
                            <input
                              type="text"
                              value={scSearchQuery}
                              onChange={(e) => { setScSearchQuery(e.target.value); setSoundcloudError(null) }}
                              onKeyDown={(e) => e.key === 'Enter' && handleSoundcloudSearch()}
                              placeholder="Search by song name or artist…"
                              className="flex-1 bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-orange-500/60 placeholder:text-white/25"
                            />
                            <button
                              onClick={handleSoundcloudSearch}
                              disabled={!scSearchQuery.trim() || isScSearching}
                              className="shrink-0 bg-white/10 hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium px-4 py-2.5 rounded-xl text-sm transition-colors flex items-center gap-1.5"
                            >
                              {isScSearching ? (
                                <>
                                  <span className="w-3.5 h-3.5 border-2 border-white/60 border-t-transparent rounded-full animate-spin" />
                                  Searching…
                                </>
                              ) : (
                                <>
                                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                                    <path
                                      fillRule="evenodd"
                                      d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
                                      clipRule="evenodd"
                                    />
                                  </svg>
                                  Search
                                </>
                              )}
                            </button>
                          </div>
                          <div className="flex gap-2">
                            <input
                              type="url"
                              value={soundcloudUrl}
                              onChange={(e) => { setSoundcloudUrl(e.target.value); setSoundcloudError(null) }}
                              onKeyDown={(e) => e.key === 'Enter' && handleSoundcloudImport()}
                              placeholder="https://soundcloud.com/artist/track"
                              className="flex-1 bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-orange-500/60 placeholder:text-white/25"
                            />
                            <button
                              onClick={handleSoundcloudImport}
                              disabled={!soundcloudUrl.trim()}
                              className="shrink-0 bg-orange-500/80 hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium px-4 py-2.5 rounded-xl text-sm transition-colors"
                            >
                              Import &amp; Clean
                            </button>
                          </div>
                          {soundcloudError && (
                            <p className="mt-2 text-red-400 text-sm">{soundcloudError}</p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Manual lyrics input — expandable, hidden while processing */}
            {!isProcessing && !isSoundcloudImporting && (
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

        {/* Review screen — waveform-based, shown between processing and download */}
        {pendingReview && (
          <WaveformReview
            audioUrl={pendingReview.originalUrl}
            originalFilename={pendingReview.originalFilename}
            words={pendingReview.words}
            detectionMethod={pendingReview.detectionMethod}
            muteType={muteType}
            isReprocessing={isReprocessing}
            onWordsChange={handleWordsChange}
            onConfirm={handleConfirm}
            onCancel={() => { setPendingReview(null); setStatus(null) }}
          />
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
                      {timeAgo(song.created_at)} ·{' '}
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
