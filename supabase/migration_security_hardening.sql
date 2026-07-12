-- ============================================================
-- Bleeep — SECURITY HARDENING migration
-- Run this in your Supabase SQL Editor (safe to re-run).
-- ============================================================
-- This closes a set of privilege-escalation / enforcement-bypass holes that
-- existed because the browser holds the Supabase ANON key and could write to
-- application tables directly, bypassing the API routes that enforce billing
-- plans, usage limits, and input validation.
--
-- The rule after this migration: the browser (authenticated role) may only
-- READ its own rows. Every write to profiles / songs / processing_jobs goes
-- through a server route using the service-role key, where limits and
-- validation live. The worker already uses the service-role key.
-- ============================================================

-- ── 1. profiles — the critical one ──────────────────────────
-- Before: "Users can update own profile" + UPDATE grant let ANY logged-in user
--   run  update profiles set plan='pro', songs_processed_this_month=0
--   from the browser — free unlimited access and a self-serve "Pro" upgrade
--   without ever paying. Plan/usage/stripe_customer_id are billing state and
--   must only be written server-side (Stripe webhook, usage accounting).
drop policy if exists "Users can update own profile" on public.profiles;
revoke update, insert, delete on public.profiles from authenticated;
-- Keep SELECT so the app can still read the user's own plan/usage.
grant select on public.profiles to authenticated;

-- ── 2. songs ────────────────────────────────────────────────
-- Before: INSERT/UPDATE grants + policies let the browser create songs rows
--   directly (bypassing the plan-limit check in /api/process) and edit
--   clean_url / words_detected on any of its rows. All song writes happen
--   server-side via the service role, so the browser needs SELECT only.
drop policy if exists "Users can insert own songs" on public.songs;
drop policy if exists "Users can update own songs" on public.songs;
revoke insert, update, delete on public.songs from authenticated;
grant select on public.songs to authenticated;

-- ── 3. processing_jobs ──────────────────────────────────────
-- Before: an INSERT grant + policy let the browser enqueue unlimited jobs
--   directly — bypassing the free-tier usage limit AND letting a user set an
--   arbitrary source_url the worker would fetch (server-side request forgery)
--   and download through MVSEP / AssemblyAI at your expense. Jobs are created
--   only by the server routes (service role). The browser needs SELECT for the
--   Realtime progress subscription.
drop policy if exists "Users can insert own jobs" on public.processing_jobs;
revoke insert, update, delete on public.processing_jobs from authenticated;
grant select on public.processing_jobs to authenticated;

-- ── 4. song_timestamps ──────────────────────────────────────
-- Already correct (RLS on, no policies, service-role only). Re-assert that the
-- browser roles have no access, in case an older grant lingers.
revoke all on public.song_timestamps from authenticated, anon;

-- ============================================================
-- 5. STORAGE HARDENING — must be set in the Dashboard, not here
-- ============================================================
-- The "audio" bucket is currently PUBLIC: every uploaded original AND every
-- rendered clean file is world-readable to anyone with the URL, forever. For
-- copyrighted music this is both a legal and a privacy exposure. Two actions,
-- both in Dashboard → Storage → audio → Settings:
--
--   (a) Set a file size limit (e.g. 50 MB) and restrict allowed MIME types to
--       audio/mpeg, audio/wav, audio/wave, audio/x-wav. Right now the 50 MB /
--       mp3-wav rule is enforced ONLY in the browser dropzone; an authenticated
--       user can upload any size/type straight to storage via the upload policy.
--
--   (b) Strongly recommended: make the bucket PRIVATE and serve downloads via
--       short-lived signed URLs (createSignedUrl) generated in an authenticated
--       server route. See SECURITY.md → "Storage privacy" for the code change.
--
-- The existing upload policy is correct (a user may only write under its own
-- user-id folder); leaving it as-is is fine:
--   with check ( bucket_id='audio' and auth.uid()::text = (storage.foldername(name))[2] )
-- ============================================================
