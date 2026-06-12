-- ============================================================
-- Vocal Isolation (Replicate Demucs)
-- Run this in your Supabase SQL Editor
-- (Dashboard → SQL Editor → New Query → Paste → Run)
-- ============================================================

-- Demucs stems are uploaded to storage during /api/process and reused by
-- /api/reprocess after waveform review, so Demucs only runs once per song.
alter table public.songs add column if not exists vocals_url text;
alter table public.songs add column if not exists instrumental_url text;
