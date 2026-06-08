-- ============================================================
-- Bleeep Database Schema
-- Run this entire file in your Supabase SQL Editor
-- (Dashboard → SQL Editor → New Query → Paste → Run)
-- ============================================================

-- ── 1. profiles table ──────────────────────────────────────
create table if not exists public.profiles (
  id                          uuid primary key references auth.users(id) on delete cascade,
  email                       text,
  plan                        text not null default 'free' check (plan in ('free', 'pro')),
  songs_processed_this_month  integer not null default 0,
  stripe_customer_id          text,
  created_at                  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Users can only read/update their own profile
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- ── 2. songs table ─────────────────────────────────────────
create table if not exists public.songs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  original_filename text,
  original_url      text,
  clean_url         text,
  words_detected    jsonb default '[]'::jsonb,
  status            text not null default 'processing' check (status in ('processing', 'complete', 'failed')),
  created_at        timestamptz not null default now()
);

alter table public.songs enable row level security;

-- Users can only see and manage their own songs
create policy "Users can view own songs"
  on public.songs for select
  using (auth.uid() = user_id);

create policy "Users can insert own songs"
  on public.songs for insert
  with check (auth.uid() = user_id);

create policy "Users can update own songs"
  on public.songs for update
  using (auth.uid() = user_id);

-- ── 3. Auto-create profile on signup ───────────────────────
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

-- Drop trigger if it exists, then recreate
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── 4. Monthly usage reset (run via a cron job or manually) ─
-- This function resets the monthly counter for all users.
-- You can schedule it in Supabase using pg_cron or call it manually.
create or replace function public.reset_monthly_usage()
returns void as $$
begin
  update public.profiles set songs_processed_this_month = 0;
end;
$$ language plpgsql security definer;

-- ── 5. Storage buckets ──────────────────────────────────────
-- Run these separately in the Supabase dashboard Storage tab:
-- 1. Create a bucket named "audio"
-- 2. Set it to PUBLIC (so download URLs work without expiration)
-- OR run these SQL statements:

insert into storage.buckets (id, name, public)
values ('audio', 'audio', true)
on conflict (id) do nothing;

-- Storage policies: users can upload/read their own files
create policy "Users can upload audio"
  on storage.objects for insert
  with check (
    bucket_id = 'audio' and
    auth.uid()::text = (storage.foldername(name))[2]
  );

create policy "Public audio read"
  on storage.objects for select
  using (bucket_id = 'audio');

-- ── 6. Table-level grants ────────────────────────────────────
-- service_role bypasses RLS but still needs explicit GRANT on
-- tables created after Supabase's initial setup.
-- authenticated role needs grants for the RLS policies to fire.
grant select, insert, update, delete on public.profiles to service_role;
grant select, insert, update, delete on public.songs    to service_role;
grant select, update                 on public.profiles to authenticated;
grant select, insert, update         on public.songs    to authenticated;

-- ── 7. Indexes ──────────────────────────────────────────────
create index if not exists songs_user_id_idx on public.songs(user_id);
create index if not exists songs_created_at_idx on public.songs(created_at desc);
create index if not exists profiles_stripe_id_idx on public.profiles(stripe_customer_id);
