/**
 * The Entity's content lexicon — every word/phrase the AI can flag, organized
 * by category and severity so different cleanliness profiles can target
 * different tiers of content.
 *
 * Categories:
 *   profanity   — classic curse words
 *   slur        — slurs and hate terms (always maximum severity)
 *   sexual      — sexually explicit or suggestive words AND multi-word phrases
 *   substances  — drug/alcohol references
 *   violence    — violent imagery (only flagged by the strictest profile)
 *
 * Severity:
 *   3 — explicit; flagged by every profile
 *   2 — strong; flagged by radio/family profiles
 *   1 — mild; flagged only when the profile asks for it
 */

export type ContentCategory = 'profanity' | 'slur' | 'sexual' | 'substances' | 'violence'
export type Severity = 1 | 2 | 3

export interface LexiconEntry {
  /** Canonical form (lowercase). Multi-word phrases contain spaces. */
  term: string
  category: ContentCategory
  severity: Severity
}

/** A cleanliness profile maps each category to the minimum severity it censors
 *  (higher = more permissive). A category absent from the map is never flagged. */
export type CensorProfile = 'radio' | 'family' | 'strict'

export const PROFILES: Record<CensorProfile, Partial<Record<ContentCategory, Severity>>> = {
  // Standard "clean edit": all profanity + slurs, explicit sexual terms only.
  radio: { profanity: 1, slur: 1, sexual: 3 },
  // Family listening: adds suggestive sexual phrases + strong drug references.
  family: { profanity: 1, slur: 1, sexual: 2, substances: 2 },
  // Squeaky clean: everything in the lexicon, including violence imagery.
  strict: { profanity: 1, slur: 1, sexual: 1, substances: 1, violence: 1 },
}

const W = (
  category: ContentCategory,
  severity: Severity,
  ...terms: string[]
): LexiconEntry[] => terms.map((term) => ({ term, category, severity }))

/**
 * Single-word entries. Everything from the original bleeep list is preserved
 * (same censoring behavior for existing users) and categorized.
 */
export const WORD_ENTRIES: LexiconEntry[] = [
  // ── Profanity: severity 3 (explicit) ────────────────────────────────────
  ...W('profanity', 3,
    'fuck', 'fucker', 'fuckers', 'fucking', 'fuckin', 'fucked', 'fucks',
    'motherfucker', 'motherfucking', 'motherfuckers', 'mf', 'mfer',
    'fuk', 'fuq', 'phuck', 'f*ck', 'f**k', 'fck', 'effing',
    'shit', 'shits', 'shitting', 'shitted', 'shitty', 'bullshit', 'dipshit',
    'horseshit', 'sh*t', 'sh1t',
    'cunt', 'cunts', 'c*nt',
    'cock', 'cocks', 'c*ck',
    'pussy', 'pussies', 'p*ssy',
    'dick', 'dicks', 'dickhead', 'd*ck',
  ),
  // ── Profanity: severity 2 (strong) ──────────────────────────────────────
  ...W('profanity', 2,
    'ass', 'asshole', 'assholes', 'asses', 'jackass', 'jackasses',
    'smartass', 'badass', 'dumbass', 'lardass', 'fatass', 'a**', 'a**hole',
    'bitch', 'bitches', 'bitching', 'bitchy', 'b*tch', 'biatch', 'byatch', 'bih',
    'bastard', 'bastards',
    'piss', 'pissed', 'pissing',
    'twat', 'wanker', 'bollocks',
  ),
  // ── Profanity: severity 1 (mild) ────────────────────────────────────────
  ...W('profanity', 1,
    'damn', 'dammit', 'goddamn', 'goddamned',
    'hell',
    'crap', 'crappy',
  ),

  // ── Slurs: always severity 3 ────────────────────────────────────────────
  ...W('slur', 3,
    'nigga', 'niggas', 'nigger', 'niggers', 'n*gga', 'n*gger',
    'fag', 'faggot', 'faggots',
    'retard', 'retarded',
    'tranny', 'trannies',
    'spic', 'spics', 'chink', 'chinks', 'kike', 'kikes', 'wetback', 'wetbacks',
  ),

  // ── Sexual: severity 3 (explicit) ───────────────────────────────────────
  ...W('sexual', 3,
    'whore', 'whores', 'slut', 'sluts', 'skank', 'thot', 'thots',
    'hoe', 'hoes', 'ho',
    'blowjob', 'blowjobs', 'handjob', 'rimjob',
    'titties', 'tits', 'boobs',
    'dildo', 'orgasm', 'orgasms', 'cum', 'cums', 'cumming', 'jizz',
    'horny', 'kinky',
  ),
  // ── Sexual: severity 2 (suggestive) ─────────────────────────────────────
  ...W('sexual', 2,
    'sex', 'sexting', 'stripper', 'strippers', 'lapdance', 'threesome',
    'naked', 'nudes', 'panties', 'lingerie', 'freaky', 'moan', 'moaning',
  ),
  // ── Sexual: severity 1 (mild innuendo) ──────────────────────────────────
  ...W('sexual', 1,
    'sexy', 'seduce', 'strip', 'undress',
  ),

  // ── Substances: severity 3 (hard drugs) ─────────────────────────────────
  ...W('substances', 3,
    'cocaine', 'coke', 'crack', 'crackhead', 'heroin', 'meth', 'fentanyl',
    'percocet', 'percocets', 'percs', 'xanax', 'xans', 'xannies',
    'molly', 'oxy', 'oxycontin', 'lean', 'codeine', 'shrooms', 'acid', 'lsd',
  ),
  // ── Substances: severity 2 ──────────────────────────────────────────────
  ...W('substances', 2,
    'weed', 'blunt', 'blunts', 'joint', 'joints', 'kush', 'marijuana',
    'ganja', 'dope', 'zaza', 'gas', 'reefer', 'stoned', 'blazed',
  ),
  // ── Substances: severity 1 (alcohol / soft) ─────────────────────────────
  ...W('substances', 1,
    'drunk', 'wasted', 'hennessy', 'henny', 'tequila', 'vodka', 'liquor',
    'shots', 'hangover', 'high',
  ),

  // ── Violence: strict profile only ───────────────────────────────────────
  ...W('violence', 2,
    'glock', 'gat', 'shank', 'murda', 'homicide', 'genocide',
  ),
  ...W('violence', 1,
    'gun', 'guns', 'shoot', 'shooter', 'shooting', 'kill', 'killed', 'killing',
    'murder', 'murdered', 'stab', 'stabbed', 'bullet', 'bullets', 'trigger',
    'blood', 'bleed', 'corpse', 'grave',
  ),
]

/**
 * Multi-word suggestive phrases. Matched as consecutive transcript words, so
 * "take it off" flags the whole 3-word span while "take the day off" doesn't.
 */
export const PHRASE_ENTRIES: LexiconEntry[] = [
  ...W('sexual', 2,
    'take it off',
    'take your clothes off',
    'take my clothes off',
    'clothes come off',
    'make love',
    'making love',
    'in my bed', 'in your bed', 'in the bed',
    'between the sheets',
    'under the covers',
    'ride it', 'ride me', 'ride him', 'ride her',
    'blow me',
    'suck my', 'suck it', 'suck on',
    'eat it up',
    'hit it from the back',
    'from the back',
    'back that ass up',
    'body on my body',
    'body on me',
    'skin to skin',
    'all over your body', 'all over my body', 'all over me', 'all over you',
    'turn me on', 'turns me on', 'turn you on',
    'get you wet', 'gettin wet', 'getting wet',
    'on your knees', 'on my knees', 'on her knees', 'on his knees',
    'one night stand',
    'netflix and chill',
    'do it all night', 'all night long',
    'freak in the sheets',
    'give it to me', 'give it to you', 'give it to her', 'give it to him',
    'put it in',
    'go down on',
    'roll in the hay',
    'get it on',
    'lay you down', 'lay me down',
    'strip it down',
    'no clothes on', 'with no clothes',
  ),
  ...W('substances', 2,
    'roll up', 'rolled up', 'rolling up',
    'light it up', 'smoke it', 'smoke one', 'get high', 'so high', 'getting high',
    'pop a pill', 'pop pills', 'popping pills', 'poppin pills',
    'sipping lean', 'sippin lean',
    'off the henny', 'off the liquor',
  ),
  ...W('violence', 1,
    'pull the trigger', 'pulled the trigger',
    'shoot you down', 'shot him down', 'shot her down',
    'blow your brains',
    'body drop', 'bodies drop',
    'catch a body', 'caught a body',
  ),
]

/** Category display metadata shared with the UI (kept here as source of truth). */
export const CATEGORY_LABELS: Record<ContentCategory, string> = {
  profanity: 'Profanity',
  slur: 'Slur',
  sexual: 'Suggestive',
  substances: 'Substances',
  violence: 'Violence',
}

/**
 * Explicit stems for embedded-profanity detection: transcription often glues
 * profanity into compounds the word list can't enumerate ("fuckboy",
 * "shithead", "bitchass"). Stems are long/unambiguous enough that substring
 * matching cannot hit an innocent word ("ass" is deliberately NOT a stem —
 * "class", "bass", "assist" must never match).
 */
export const EMBEDDED_STEMS: Array<{ stem: string; category: ContentCategory; severity: Severity }> = [
  { stem: 'fuck', category: 'profanity', severity: 3 },
  { stem: 'shit', category: 'profanity', severity: 3 },
  { stem: 'bitch', category: 'profanity', severity: 2 },
  { stem: 'cunt', category: 'profanity', severity: 3 },
  { stem: 'nigg', category: 'slur', severity: 3 },
  { stem: 'faggot', category: 'slur', severity: 3 },
  { stem: 'pussy', category: 'sexual', severity: 3 },
]

/** Word list for AssemblyAI keyterms_prompt — biases recognition toward the
 *  vocabulary the Entity needs to hear accurately. */
export const WORD_BOOST: string[] = [
  'fuck', 'fucking', 'fuckin', 'shit', 'bitch', 'ass', 'asshole',
  'nigga', 'niggas', 'nigger', 'damn', 'cunt', 'dick', 'pussy',
  'bastard', 'motherfucker', 'motherfucking', 'bullshit', 'hoe',
  'whore', 'cock', 'slut', 'fag', 'faggot', 'jackass', 'dumbass',
  'retard', 'thot', 'bih', 'percocet', 'molly', 'xanax', 'cocaine',
]
