export interface Profile {
  id: string
  email: string
  plan: 'free' | 'pro'
  songs_processed_this_month: number
  stripe_customer_id: string | null
  created_at: string
}

export interface DetectedWord {
  word: string
  start: number  // seconds
  end: number    // seconds
  mute_type: 'mute' | 'bleep'
}

export interface Song {
  id: string
  user_id: string
  original_filename: string
  original_url: string
  clean_url: string | null
  vocals_url: string | null
  instrumental_url: string | null
  words_detected: DetectedWord[] | null
  status: 'processing' | 'complete' | 'failed'
  created_at: string
}

export interface ProcessingStatus {
  stage: 'uploading' | 'analyzing' | 'processing' | 'complete' | 'failed'
  message: string
  progress: number  // 0–100
}

export type MuteType = 'mute' | 'bleep'

export type DetectionMethod = 'lyrics' | 'ai' | 'community'
