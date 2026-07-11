export type MuteType = 'mute' | 'warp' | 'bleep'

export interface DetectedWord {
  word: string
  start: number // seconds
  end: number // seconds
  mute_type: MuteType
  /** Entity metadata (present on AI detections; absent on legacy/manual words) */
  category?: 'profanity' | 'slur' | 'sexual' | 'substances' | 'violence'
  severity?: number // 1 mild · 2 strong · 3 explicit
  confidence?: number // 0–1
  source?: 'exact' | 'variant' | 'starred' | 'embedded' | 'phrase'
}

/** Per-window measurement from the Entity's post-render verification pass. */
export interface VerificationWindow {
  word: string
  start: number
  end: number
  style: MuteType
  /** Measured residual level (dB RMS) of the vocal bus inside the window. */
  residual_db: number
  threshold_db: number
  pass: boolean
}

/** The Entity's proof that the render is clean. */
export interface VerificationReport {
  verified: boolean
  attempts: number
  windows: VerificationWindow[]
  checked_at: string
}

export interface TranscriptWord {
  word: string
  start: number // seconds
  end: number // seconds
}

export type JobType = 'process' | 'reprocess'

export type JobStatus =
  | 'pending'
  | 'claimed'
  | 'downloading'
  | 'isolating'
  | 'transcribing'
  | 'processing'
  | 'uploading'
  | 'complete'
  | 'failed'

export type DetectionMethod = 'lyrics' | 'ai' | 'community'

/** A row of public.processing_jobs (see supabase/migration_processing_jobs.sql). */
export interface ProcessingJob {
  id: string
  user_id: string
  song_id: string
  job_type: JobType
  status: JobStatus
  source_type: 'soundcloud' | 'upload' | null
  source_url: string | null
  original_filename: string | null
  song_name: string | null
  artist: string | null
  album: string | null
  mute_type: MuteType
  manual_lyrics: string | null
  genius_lyrics: string | null
  words_detected: DetectedWord[] | null
  detection_method: string | null
  result_storage_path: string | null
  transcript: TranscriptWord[] | null
  verification?: VerificationReport | null
  error_message: string | null
  created_at: string
  updated_at: string
}
