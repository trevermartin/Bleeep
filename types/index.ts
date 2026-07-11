export interface Profile {
  id: string
  email: string
  plan: 'free' | 'pro'
  songs_processed_this_month: number
  stripe_customer_id: string | null
  created_at: string
}

export type ContentCategory = 'profanity' | 'slur' | 'sexual' | 'substances' | 'violence'

export interface DetectedWord {
  word: string
  start: number  // seconds
  end: number    // seconds
  mute_type: 'mute' | 'warp' | 'bleep'
  /** Entity metadata (present on AI detections; absent on legacy/manual words) */
  category?: ContentCategory
  severity?: number     // 1 mild · 2 strong · 3 explicit
  confidence?: number   // 0–1
  source?: 'exact' | 'variant' | 'starred' | 'embedded' | 'phrase'
}

/** Per-window measurement from the Entity's post-render verification pass. */
export interface VerificationWindow {
  word: string
  start: number
  end: number
  style: 'mute' | 'warp' | 'bleep'
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

export interface Song {
  id: string
  user_id: string
  original_filename: string
  original_url: string
  clean_url: string | null
  words_detected: DetectedWord[] | null
  verification?: VerificationReport | null
  status: 'processing' | 'complete' | 'failed'
  created_at: string
}

export interface ProcessingStatus {
  stage: 'uploading' | 'analyzing' | 'processing' | 'complete' | 'failed'
  message: string
  progress: number  // 0–100
}

export type MuteType = 'mute' | 'warp' | 'bleep'

export type DetectionMethod = 'lyrics' | 'ai' | 'community'
