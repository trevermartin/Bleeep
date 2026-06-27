# Bleeep

AI-powered music censorship SaaS. Upload or import a song and Bleeep automatically detects profane lyrics and censors them — no manual editing required.

## What it does
- Detects profanity in songs using AssemblyAI for AI-powered audio transcription
- Automatically censors flagged words using FFmpeg audio processing
- Waveform review UI with draggable mute regions for manual adjustments
- SoundCloud import for finding and censoring songs directly
- Stripe payments for access passes
- Supabase for auth, storage, and database

## Built with
- Next.js 14 + TypeScript
- Supabase
- AssemblyAI
- FFmpeg
- Stripe
- Tailwind CSS

## Live demo
[bleeep.vercel.app](https://bleeep.vercel.app)

## Built using Claude Code as the primary development tool
No prior software engineering background — scoped, built, and shipped using AI-assisted development.
