# Bleeep

AI-powered music censorship SaaS. Upload or import a song and the Bleeep **Entity** — an autonomous censorship engine — detects profane and suggestive lyrics, censors only the vocal, and proves the result is clean before handing it back. No manual editing required.

## What it does
- Detects profanity, slurs, and suggestive phrases with a categorized, severity-tiered lexicon (leet-speak, elongations, asterisk dodges, and compounds included) on top of AssemblyAI word-level transcription
- Separates vocals from the instrumental (MVSEP) and censors **only the vocal stem** — the music plays through 100% intact during every censored word
- Three censor styles, selectable per word: click-free **mute**, muffled **warp**, classic broadcast **bleep**
- Snaps every censor window to the energy valleys around the word in the actual vocal audio, fixing ASR timestamp drift
- **Verifies its own renders**: measures the residual voice inside every censored window after rendering, auto-widens and re-renders anything that leaks, and ships a verification report with the download
- Waveform review UI with draggable regions, per-word style switching, and category/confidence badges
- SoundCloud import for finding and censoring songs directly
- Stripe payments for access passes
- Supabase for auth, storage, and database

## The Entity (worker/src/entity)
- `lexicon.ts` — categorized content lexicon (profanity / slur / sexual / substances / violence) with three cleanliness profiles (radio, family, strict)
- `detect.ts` — phrase-aware detection over the transcript with confidence scoring
- `envelope.ts` — vocal energy envelope extraction + boundary snapping
- `verify.ts` — post-render residual measurement (ffmpeg astats) per censored window
- `index.ts` — the closed loop: render → verify → widen → re-render until provably clean

Run the proof suite (synthesizes test songs and measures the rendered audio):
```
cd worker && npm test
```

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
