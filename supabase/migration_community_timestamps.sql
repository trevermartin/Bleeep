-- ============================================================
-- Community Timestamp Library
-- Run this in your Supabase SQL Editor
-- (Dashboard → SQL Editor → New Query → Paste → Run)
-- ============================================================

create table if not exists public.song_timestamps (
  id                uuid primary key default gen_random_uuid(),
  track_fingerprint text not null,
  timestamps        jsonb not null default '[]'::jsonb,
  source_user_id    uuid references public.profiles(id) on delete set null,
  confidence_score  real not null default 1.0,
  created_at        timestamptz not null default now(),
  -- One contribution per user per track: re-finalizing the same song
  -- updates your entry instead of inflating the match count.
  unique (track_fingerprint, source_user_id)
);

-- Server-only table: all reads/writes go through the service role in API
-- routes. RLS is enabled with no policies so anon/authenticated get nothing.
alter table public.song_timestamps enable row level security;

grant select, insert, update, delete on public.song_timestamps to service_role;

create index if not exists song_timestamps_fingerprint_idx
  on public.song_timestamps(track_fingerprint);
