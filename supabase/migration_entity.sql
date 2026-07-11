-- ── Entity upgrade: bleep censor style + post-render verification reports ──
-- Run this in the Supabase SQL editor (safe to re-run).

-- 1. Allow the third censor style, 'bleep', on jobs.
alter table public.processing_jobs
  drop constraint if exists processing_jobs_mute_type_check;
alter table public.processing_jobs
  add constraint processing_jobs_mute_type_check
  check (mute_type in ('mute', 'warp', 'bleep'));

-- 2. The Entity's verification report (per-window residual measurements
--    proving each censored span is clean). Written best-effort by the worker.
alter table public.processing_jobs
  add column if not exists verification jsonb;
alter table public.songs
  add column if not exists verification jsonb;
