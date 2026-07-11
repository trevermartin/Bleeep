/**
 * The Entity's detection brain.
 *
 * Takes the word-level transcript (seconds timebase) and finds every span that
 * the active cleanliness profile says must be censored:
 *
 *  - single words, matched through a normalization gauntlet that survives the
 *    ways lyrics dodge filters: leet-speak ("f4ck", "sh1t"), asterisk-censored
 *    forms ("f*ck", "motherf**ker"), sung elongations ("fuuuuck"), and
 *    profanity embedded in compounds ("fuckboy", "bitchass")
 *  - multi-word suggestive phrases ("take it off", "pop a pill") matched as
 *    consecutive transcript words so innocent near-misses don't trigger
 *
 * Every detection carries category, severity, confidence and source so the
 * review UI can explain WHY the Entity flagged it.
 */

import type { DetectedWord, MuteType, TranscriptWord } from '../types'
import {
  EMBEDDED_STEMS,
  PHRASE_ENTRIES,
  PROFILES,
  WORD_ENTRIES,
  type CensorProfile,
  type ContentCategory,
  type LexiconEntry,
  type Severity,
} from './lexicon'

export type DetectionSource = 'exact' | 'variant' | 'starred' | 'embedded' | 'phrase'

export interface Detection extends DetectedWord {
  category: ContentCategory
  severity: Severity
  confidence: number
  source: DetectionSource
}

// ── Lookup structures (built once at module load) ────────────────────────────

const WORD_MAP = new Map<string, LexiconEntry>()
for (const e of WORD_ENTRIES) WORD_MAP.set(e.term, e)

const PHRASE_MAP = new Map<string, LexiconEntry>()
let MAX_PHRASE_LEN = 1
for (const e of PHRASE_ENTRIES) {
  PHRASE_MAP.set(e.term, e)
  MAX_PHRASE_LEN = Math.max(MAX_PHRASE_LEN, e.term.split(' ').length)
}

/** Canonical (asterisk-free) single-word terms, for starred-wildcard matching. */
const CLEAN_TERMS = WORD_ENTRIES.filter((e) => !e.term.includes('*'))

/** De-leeted forms that are innocent real words — vowel-wildcard matching
 *  must not resurrect them as profanity ("sh0t"→"shot", "d0ck"→"dock"). */
const SAFE_DELEET = new Set([
  'shot', 'shots', 'dock', 'docks', 'duck', 'ducks', 'deck', 'decks',
  'sick', 'sock', 'socks', 'shat', 'hit', 'hits', 'hat', 'hats', 'hot',
])

// ── Token normalization ───────────────────────────────────────────────────────

const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
  '@': 'a', '$': 's', '!': 'i',
}

/** Lowercase + keep only letters/digits/asterisks/apostrophes-as-nothing. */
export function cleanToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9*@$!]/g, '')
}

function deLeet(token: string): string {
  return token.replace(/[0134578@$!]/g, (c) => LEET[c] ?? c)
}

/** Collapse letter runs: "fuuuuck" → "fuck" (runs of 3+ → 1, then 2 → 1 as an
 *  extra candidate is generated separately to avoid "pissed" → "pised"). */
function collapseRuns(token: string, maxRun: number): string {
  return token.replace(
    new RegExp(`([a-z])\\1{${maxRun},}`, 'g'),
    (_m, c: string) => c.repeat(maxRun)
  )
}

/** All normalized candidate spellings of a raw transcript token. */
export function tokenCandidates(raw: string): string[] {
  const cleaned = cleanToken(raw)
  if (!cleaned) return []
  const out = new Set<string>([cleaned])
  const deleeted = deLeet(cleaned)
  out.add(deleeted)
  // Elongation collapse on the de-leeted form: runs of 3+ down to 2, then 1
  out.add(collapseRuns(deleeted, 2))
  out.add(collapseRuns(deleeted, 1))
  return Array.from(out).filter(Boolean)
}

export interface TokenHit {
  entry: LexiconEntry
  confidence: number
  source: DetectionSource
}

/**
 * Match one raw transcript token against the lexicon.
 * Returns the strongest hit or null.
 */
export function matchToken(raw: string): TokenHit | null {
  const candidates = tokenCandidates(raw)
  if (candidates.length === 0) return null
  const primary = candidates[0]

  // 1. Exact / normalized-variant lookup
  for (let i = 0; i < candidates.length; i++) {
    const entry = WORD_MAP.get(candidates[i])
    if (entry) {
      return { entry, confidence: i === 0 ? 1.0 : 0.9, source: i === 0 ? 'exact' : 'variant' }
    }
  }

  // 2. Starred-censored form: "f*ck", "motherf**ker" → wildcard match
  if (primary.length >= 3 && primary.includes('*')) {
    const re = new RegExp('^' + primary.replace(/[.+?^${}()|[\]\\]/g, '').replace(/\*+/g, '[a-z]*') + '$')
    const entry = CLEAN_TERMS.find((e) => re.test(e.term))
    if (entry) return { entry, confidence: 0.85, source: 'starred' }
  }

  // 2b. Symbol-as-vowel dodge: "f4ck", "sh!t" where the mapped letter isn't
  //     the real one (4→a gives "fack"). Treat each leet symbol as a vowel
  //     wildcard — but never override a de-leet that lands on an innocent
  //     word ("sh0t" → "shot" stays clean).
  if (primary.length >= 3 && /[0134578@$!]/.test(primary) && !primary.includes('*')) {
    const deleeted = deLeet(primary)
    if (!SAFE_DELEET.has(deleeted)) {
      const re = new RegExp(
        '^' + primary.replace(/[.+?^${}()|[\]\\]/g, '').replace(/[0134578@$!]/g, '[aeiou]') + '$'
      )
      const entry = CLEAN_TERMS.find((e) => re.test(e.term))
      if (entry) return { entry, confidence: 0.85, source: 'variant' }
    }
  }

  // 3. Embedded profanity in compounds: "fuckboy", "bitchass", "shithead".
  //    Only unambiguous stems (see EMBEDDED_STEMS) and only when the token is
  //    strictly longer than the stem (the exact word was handled above).
  for (const cand of candidates) {
    if (cand.includes('*')) continue
    for (const s of EMBEDDED_STEMS) {
      if (cand.length > s.stem.length && cand.includes(s.stem)) {
        return {
          entry: { term: cand, category: s.category, severity: s.severity },
          confidence: 0.75,
          source: 'embedded',
        }
      }
    }
  }

  return null
}

// ── Profile gate ──────────────────────────────────────────────────────────────

function passesProfile(entry: LexiconEntry, profile: CensorProfile): boolean {
  const minSeverity = PROFILES[profile][entry.category]
  return minSeverity !== undefined && entry.severity >= minSeverity
}

// ── Main detection pass ───────────────────────────────────────────────────────

export interface DetectOptions {
  profile?: CensorProfile
  muteType?: MuteType
}

/**
 * Scan the full transcript and return every censorable span, sorted by start
 * time, with overlapping spans merged (a phrase hit swallows the single-word
 * hits inside it).
 */
export function detectContent(
  transcript: TranscriptWord[],
  opts: DetectOptions = {}
): Detection[] {
  const profile = opts.profile ?? 'family'
  const muteType = opts.muteType ?? 'mute'
  const hits: Detection[] = []

  // Pre-normalize every token once (primary candidate) for phrase matching
  const norm = transcript.map((w) => {
    const c = tokenCandidates(w.word)
    return c.length > 0 ? collapseRuns(deLeet(c[0]), 2) : ''
  })

  // 1. Phrase pass — longest phrases first so "take your clothes off" wins
  //    over any shorter overlap.
  const phraseCovered = new Array<boolean>(transcript.length).fill(false)
  for (let len = MAX_PHRASE_LEN; len >= 2; len--) {
    for (let i = 0; i + len <= transcript.length; i++) {
      if (phraseCovered[i]) continue
      const gram = norm.slice(i, i + len)
      if (gram.some((t) => !t)) continue
      const entry = PHRASE_MAP.get(gram.join(' '))
      if (!entry || !passesProfile(entry, profile)) continue
      // Phrases must be sung consecutively — reject grams that span a gap
      // longer than 1.5s between adjacent words (verse boundaries).
      let contiguous = true
      for (let k = i; k < i + len - 1; k++) {
        if (transcript[k + 1].start - transcript[k].end > 1.5) { contiguous = false; break }
      }
      if (!contiguous) continue
      hits.push({
        word: entry.term,
        start: transcript[i].start,
        end: transcript[i + len - 1].end,
        mute_type: muteType,
        category: entry.category,
        severity: entry.severity,
        confidence: 0.8,
        source: 'phrase',
      })
      for (let k = i; k < i + len; k++) phraseCovered[k] = true
    }
  }

  // 2. Single-word pass (skipping words already inside a matched phrase)
  for (let i = 0; i < transcript.length; i++) {
    if (phraseCovered[i]) continue
    const hit = matchToken(transcript[i].word)
    if (!hit || !passesProfile(hit.entry, profile)) continue
    hits.push({
      word: hit.entry.term,
      start: transcript[i].start,
      end: transcript[i].end,
      mute_type: muteType,
      category: hit.entry.category,
      severity: hit.entry.severity,
      confidence: hit.confidence,
      source: hit.source,
    })
  }

  hits.sort((a, b) => a.start - b.start || a.end - b.end)
  return mergeOverlaps(hits)
}

/** Merge detections whose spans overlap (or nearly touch, < 150ms apart) —
 *  back-to-back flagged words form one natural censor window. */
function mergeOverlaps(sorted: Detection[]): Detection[] {
  const out: Detection[] = []
  for (const d of sorted) {
    const last = out[out.length - 1]
    if (last && d.start <= last.end + 0.15) {
      last.end = Math.max(last.end, d.end)
      if (d.severity > last.severity) {
        last.category = d.category
        last.severity = d.severity
      }
      if (!last.word.includes(d.word)) last.word = `${last.word} ${d.word}`
      last.confidence = Math.max(last.confidence, d.confidence)
    } else {
      out.push({ ...d })
    }
  }
  return out
}
