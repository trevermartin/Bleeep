export type MuteType = 'mute' | 'warp'

export interface DetectedWord {
  word: string
  start: number // seconds
  end: number // seconds
  mute_type: MuteType
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
  error_message: string | null
  created_at: string
  updated_at: string
}
