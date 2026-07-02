-- ============================================================
-- Processing Jobs (Railway worker queue)
-- Run this in your Supabase SQL Editor
-- (Dashboard → SQL Editor → New Query → Paste → Run)
-- ============================================================
-- Heavy audio processing (yt-dlp download, MVSEP isolation, AssemblyAI
-- transcription, FFmpeg render) runs on a persistent Railway worker instead
-- of Vercel, which kills serverless functions at ~60s. Vercel inserts a
-- 'pending' job here; the worker claims it, runs the pipeline, writes the
-- results into public.songs, and updates this row's `status` after each stage
-- so Supabase Realtime can push progress to the browser.

create table if not exists public.processing_jobs (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,

  -- Links to the public.songs row the worker writes results into. The Vercel
  -- route inserts that songs row (status 'processing') up front so the song
  -- shows in the library immediately; the worker flips it to complete/failed.
  song_id             uuid not null,

  -- 'process'  = full pipeline (download → isolate → transcribe → render)
  -- 'reprocess'= re-render the user-edited word list only (reuses cached stems)
  job_type            text not null default 'process'
                        check (job_type in ('process', 'reprocess')),

  -- Pipeline stage. Realtime pushes each transition to the frontend.
  status              text not null default 'pending'
                        check (status in ('pending', 'claimed', 'downloading',
                                          'isolating', 'transcribing', 'processing',
                                          'uploading', 'complete', 'failed')),

  source_type         text check (source_type in ('soundcloud', 'upload')),
  source_url          text,            -- soundcloud URL, or storage path for uploads

  original_filename   text,
  song_name           text,
  artist              text,
  album               text,

  -- Processing parameters carried from the original request.
  mute_type           text not null default 'mute' check (mute_type in ('mute', 'warp')),
  manual_lyrics       text,            -- optional pasted LRC override
  genius_lyrics       text,            -- optional lyrics hint (from the search step)

  -- For 'reprocess' jobs: the user-edited word list to render.
  -- For completed jobs: the detected words handed back to the review UI.
  words_detected      jsonb,
  detection_method    text,            -- 'ai' | 'lyrics' | 'community'

  result_storage_path text,            -- clean file storage path
  transcript          jsonb,           -- full word-level transcript for the review panel
  error_message       text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.processing_jobs enable row level security;

-- Users can see and create their own jobs. The Railway worker uses the
-- service_role key, which bypasses RLS entirely.
drop policy if exists "Users can view own jobs" on public.processing_jobs;
create policy "Users can view own jobs"
  on public.processing_jobs for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own jobs" on public.processing_jobs;
create policy "Users can insert own jobs"
  on public.processing_jobs for insert
  with check (auth.uid() = user_id);

-- Grants: service_role for the worker, authenticated for the RLS-gated
-- select/insert the browser performs.
grant select, insert, update, delete on public.processing_jobs to service_role;
grant select, insert                 on public.processing_jobs to authenticated;

-- Keep updated_at fresh on every worker stage transition.
create or replace function public.touch_processing_jobs_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists processing_jobs_updated_at on public.processing_jobs;
create trigger processing_jobs_updated_at
  before update on public.processing_jobs
  for each row execute procedure public.touch_processing_jobs_updated_at();

-- The worker claims the oldest pending job; these indexes keep that fast.
create index if not exists processing_jobs_status_created_idx
  on public.processing_jobs(status, created_at);
create index if not exists processing_jobs_user_id_idx
  on public.processing_jobs(user_id);

-- ── Enable Supabase Realtime ────────────────────────────────
-- The frontend subscribes to row changes (filtered by id) for live progress.
-- Idempotent: only add the table to the realtime publication if not present.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'processing_jobs'
  ) then
    alter publication supabase_realtime add table public.processing_jobs;
  end if;
end $$;
