# Bleeep — Security Review & Hardening

This document is the full output of a security audit of the Bleeep codebase
(Next.js app + Railway worker + Supabase). It lists **every** issue found,
what was fixed in code, and — importantly — the items that **only you can
resolve** because they live in the Supabase/Stripe dashboards, in
infrastructure, or in legal/policy.

Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low

---

## Part 1 — Fixed in this change

### 🔴 C1. Any user could make themselves "Pro" and reset their usage (privilege escalation / billing bypass)
**Where:** `supabase/schema.sql` — the `profiles` UPDATE policy
`using (auth.uid() = id)` combined with an `UPDATE` grant to `authenticated`.
**Problem:** the browser holds the Supabase **anon key**. With it, any logged-in
user could run, straight from the devtools console:
```js
supabase.from('profiles').update({ plan: 'pro', songs_processed_this_month: 0 }).eq('id', MY_ID)
```
That flips them to Pro (unlimited, paid features) **without paying**, and
zeroes their monthly counter at will. Billing state must never be writable by
the client.
**Fix:** `migration_security_hardening.sql` drops the update policy and
**revokes INSERT/UPDATE/DELETE on `profiles` from `authenticated`** (SELECT
kept). Plan/usage are now written only server-side (Stripe webhook + usage
accounting via the service-role key).

### 🔴 C2. Usage-limit bypass + SSRF by inserting jobs directly (enforcement bypass)
**Where:** `songs` and `processing_jobs` INSERT policies + `authenticated`
INSERT grants.
**Problem:** the free-tier limit and all input validation live in the API
routes — but the browser never actually needed them. With the anon key a user
could insert `songs` and `processing_jobs` rows directly, which means:
- enqueue **unlimited** jobs → bypass the 3-songs/month free limit and run up
  your MVSEP + AssemblyAI bills;
- set an **arbitrary `source_url`** the worker then fetches and forwards to
  MVSEP → **server-side request forgery** (cloud-metadata endpoints, internal
  services, etc.).
**Fix:** `migration_security_hardening.sql` **revokes INSERT/UPDATE/DELETE on
`songs` and `processing_jobs` from `authenticated`** (SELECT kept for history +
the Realtime progress subscription). All writes now go through the service-role
API routes, where limits and validation are enforced. Verified that no
browser-side code writes to these tables (only `lib/jobs-client.ts` SELECTs).

### 🔴 C3. SSRF via `originalUrl` even through the API route
**Where:** `app/api/process/route.ts`.
**Problem:** `originalUrl` was accepted from the request body and passed to the
worker to `fetch()` (and hand to MVSEP) with no validation. A caller could
point it anywhere.
**Fix:** the route now requires `originalUrl` to be an `https://` URL under the
caller's **own** storage prefix
(`…/storage/v1/object/public/audio/originals/<their-user-id>/`). Anything else
is rejected. This also prevents referencing another user's file. Defense in
depth: the worker's `planWindows` and the URL checks below.

### 🟠 H1. Open redirect in the OAuth callback
**Where:** `app/auth/callback/route.ts` — `redirect(`${origin}${next}`)`.
**Problem:** `next` was concatenated unvalidated. `next=@evil.com` yields
`https://yourapp.com@evil.com`, which browsers resolve to **evil.com** — a
working open redirect (useful for phishing/OAuth token theft).
**Fix:** `safeNext()` accepts only single-slash-rooted relative paths, rejecting
absolute, protocol-relative (`//`), backslash (`/\`), and userinfo (`@`) tricks;
falls back to `/dashboard`.

### 🟠 H2. Unvalidated `wordsDetected` reaching the ffmpeg filtergraph
**Where:** `app/api/reprocess/route.ts` → worker `services/audio.ts`.
**Problem:** `start`/`end` are typed `number` but never validated at runtime;
the client can send anything. They are interpolated into the ffmpeg
filtergraph. Non-numeric/NaN values at minimum crash the render (DoS); the
intent was to prevent any chance of filtergraph string injection.
**Fix:** `sanitizeWords()` in the reprocess route coerces to finite, ordered,
non-negative numbers, validates `mute_type` against the enum, caps the list at
500 entries and word labels at 100 chars, and drops anything malformed. The
worker's `planWindows()` **independently** re-coerces and filters (never trusts
upstream).

### 🟠 H3 (partial). Worker `/genius-lyrics` ran as an open proxy when misconfigured
**Where:** `worker/src/index.ts`.
**Problem:** if `WORKER_SECRET` was unset it logged a warning but still served
requests — an unauthenticated, cost-bearing scraping endpoint.
**Fix:** it now **fails closed** (503) when no secret is configured. (See P2 for
the broader rate-limiting gap.)

### 🟡 M1. Verbose error messages leaked internals to clients
**Where:** `process`, `soundcloud`, `soundcloud/search` routes returned raw DB
error text (codes, column hints) and raw yt-dlp stderr to the browser.
**Fix:** all now return generic messages to the client and log the detail
server-side only.

### 🟡 M2. Missing security headers / CSP
**Where:** `next.config.mjs`.
**Fix:** added `Content-Security-Policy` (scoped to self + Supabase + Stripe,
`frame-ancestors 'none'`, `object-src 'none'`), `X-Content-Type-Options`,
`X-Frame-Options: DENY`, HSTS (2y, preload), `Referrer-Policy`, and
`Permissions-Policy`. **Test the CSP in staging** — if you later add analytics,
fonts, or other third-party scripts you'll need to widen the relevant
directives.

### 🟡 M3. Input length bounds
**Where:** `process` + `soundcloud` routes.
**Fix:** filenames, pasted lyrics, Genius lyrics, and track/artist names are now
length-capped before they hit the DB/logs, and `songId` must be a UUID.

---

## Part 2 — Requires YOUR action (cannot be fixed in code alone)

### 🔴 L1 (apply the migration). Run the hardening SQL
The C1/C2 fixes are a **database** change. Until you run it, the browser can
still self-upgrade to Pro. **Action:** open Supabase → SQL Editor and run
`supabase/migration_security_hardening.sql`. Do this **first**. After running
it, verify from a normal (non-service) session that
`update profiles set plan='pro'` returns *0 rows / permission denied*.

### 🟠 P1. Storage bucket is PUBLIC — copyrighted audio is world-readable
The `audio` bucket is public, so every uploaded original **and** every rendered
"clean" file is readable by anyone with the URL, permanently, with no auth.
URLs contain UUIDs (not trivially enumerable) but they leak via logs, browser
history, referrer headers, and CDN caches. For copyrighted music this is both a
**legal** and a **privacy** exposure.
**Recommended fix (needs a code change I can do on request):** make the bucket
**private** and serve downloads through short-lived **signed URLs**
(`supabase.storage.from('audio').createSignedUrl(path, 3600)`) generated in an
authenticated server route that checks ownership. The dashboard, history, and
worker upload paths would switch from `getPublicUrl` to signed URLs. Tell me to
proceed and I'll implement it.
**Minimum interim step:** Supabase → Storage → `audio` → Settings → set a **file
size limit (50 MB)** and restrict **allowed MIME types** to
`audio/mpeg, audio/wav, audio/wave, audio/x-wav`. Today those limits exist only
in the browser dropzone; an authenticated user can upload any size/type
straight to storage.

### 🟠 P2. No rate limiting anywhere
No route is rate-limited. Even with the free-tier cap restored (C2), these
remain abusable per-account or per-IP:
- `/api/reprocess` — unlimited re-renders (worker + storage cost);
- `/api/soundcloud/search` — spawns `yt-dlp` per call;
- `/api/stripe/checkout`, `/api/stripe/portal` — Stripe API calls;
- signup — mass account creation to farm free credits.
Robust limiting needs a shared store. **Recommended:** add
[Upstash Redis + `@upstash/ratelimit`] (works on Vercel edge/serverless) or
Vercel's built-in rate limiting, keyed by user id and by IP. I can wire this in
if you provision an Upstash instance (or confirm Vercel WAF/rate-limit).

### 🟠 P3. Legal — copyright & platform ToS (the biggest non-technical risk)
Bleeep downloads tracks from SoundCloud via `yt-dlp`, sends full copyrighted
recordings to third parties (MVSEP, AssemblyAI, Genius), stores derivative
"clean" versions, and lets users download them. That implicates **reproduction,
derivative-work, and distribution** rights, and **SoundCloud's Terms of Service
explicitly prohibit** downloading/stream-ripping. This is the single largest
liability in the product. None of it is code-fixable. Before charging money you
need, at minimum:
- **Terms of Service** and **Privacy Policy** (you collect emails + audio;
  GDPR/CCPA implications — see P5);
- a **DMCA policy**, a registered **DMCA agent**, and a working
  **takedown/repeat-infringer** process;
- to reconsider the **SoundCloud import** feature specifically (highest ToS
  risk), or restrict the product to **user-uploaded files the user owns**;
- ideally, counsel review of whether your use qualifies for any license/defense.
**Please get legal advice here.** I flag it because you asked for a "legally
sound product," and this is where the real legal exposure is.

### 🟡 P4. Supabase Auth settings to enable (dashboard)
- **Confirm email** ON (Authentication → Providers → Email) so accounts can't be
  created under addresses the user doesn't control.
- **Leaked-password protection** ON (Authentication → Policies) — checks
  passwords against HaveIBeenPwned.
- Consider a **CAPCHA** (hCaptcha/Turnstile) on signup to blunt mass-signup
  credit farming (ties into P2).
- Review the **OAuth redirect allowlist** (Authentication → URL Configuration)
  so only your domains are permitted.

### 🟡 P5. Data-protection / privacy program
You store users' email addresses and their audio uploads. To be "legally sound"
you need a data-retention policy (how long originals/clean files live — right
now, forever), a deletion path (account deletion cascades in the DB via
`on delete cascade`, but **storage objects are not deleted** — orphaned audio
remains in the bucket), and the privacy disclosures in P3. **Recommended code
follow-up:** a scheduled cleanup that deletes storage objects for removed
songs/accounts, and a "delete my data" action. I can build these.

### 🟡 P6. Secret hygiene / rotation
No secrets are committed (verified). Operational reminders:
- The **service-role key** and `SUPABASE_SERVICE_ROLE_KEY` must exist only in
  server env (Vercel/Railway) — never in `NEXT_PUBLIC_*`. Currently correct.
- Set a strong **`WORKER_SECRET`** on both Vercel and Railway (the worker now
  refuses the Genius endpoint without it).
- Rotate MVSEP/AssemblyAI/Genius/Stripe keys if they were ever shared in chats,
  screenshots, or the earlier "pure tune" project.
- Ensure **`STRIPE_WEBHOOK_SECRET`** is set in production (the webhook rejects
  unsigned calls, which is correct — but a missing secret would 500 every
  event).

### ⚪ P7. Monthly usage reset must actually be scheduled
`reset_monthly_usage()` exists but is only run "manually." If never scheduled,
free users hit the cap once and are stuck forever (support burden), or —
depending on how you read it — never reset. **Action:** schedule it monthly with
Supabase `pg_cron`. (Not a security hole, but a correctness/abuse-adjacent gap.)

---

## Part 3 — Lower-severity notes (reviewed, acceptable or minor)

- ⚪ **Stripe webhook replay/idempotency:** signature verification prevents
  forgery; re-delivery of a valid event is idempotent here (it just re-sets
  `plan`). Fine as-is.
- ⚪ **`NEXT_PUBLIC_APP_URL` fallback to localhost:** if unset in prod, Stripe
  redirect URLs break. Set it in prod. (Availability, not security.)
- ⚪ **Email enumeration** on login/signup is Supabase default behavior;
  acceptable for this product tier.
- ⚪ **Worker is single-instance with an in-process `busy` flag:** fine for now;
  if you scale to multiple workers the DB `claim` is already atomic, so that's
  safe too.
- ⚪ **MVSEP/AssemblyAI/Genius receive full copyrighted audio/lyrics:** inherent
  to the design; covered by P3. Confirm each vendor's data-retention/ToS.

---

## Suggested order of operations
1. **Run `migration_security_hardening.sql`** (closes C1/C2/C3-adjacent). 🔴
2. Deploy this code (SSRF, open-redirect, validation, headers). 🔴/🟠
3. Set storage size/MIME limits; decide on private-bucket + signed URLs (P1). 🟠
4. Add rate limiting (P2) and Supabase auth hardening (P4). 🟠/🟡
5. **Get legal counsel** for ToS/Privacy/DMCA and the SoundCloud feature (P3). 🟠
6. Schedule the monthly reset (P7); build data-deletion/retention (P5).
