/**
 * Comprehensive profanity word list for detection.
 * All entries are lowercase. Comparison is case-insensitive.
 */
export const PROFANITY_LIST: string[] = [
  // F-word and variants
  'fuck', 'fucker', 'fuckers', 'fucking', 'fuckin', 'fucked', 'fucks',
  'motherfucker', 'motherfucking', 'motherfuckers', 'mf', 'mfer',
  'fuk', 'fuq', 'phuck', 'f*ck', 'f**k', 'fck', 'effing',

  // S-word and variants
  'shit', 'shits', 'shitting', 'shitted', 'shitty', 'bullshit', 'dipshit',
  'horseshit', 'sh*t', 'sh1t',

  // A-word and variants
  'ass', 'asshole', 'assholes', 'asses', 'jackass', 'jackasses',
  'smartass', 'badass', 'dumbass', 'lardass', 'fatass', 'a**', 'a**hole',

  // B-word and variants
  'bitch', 'bitches', 'bitching', 'bitchy', 'b*tch', 'biatch', 'byatch', 'bih',

  // C-word and variants
  'cunt', 'cunts', 'c*nt',

  // D-word
  'dick', 'dicks', 'dickhead', 'd*ck',

  // P-word
  'pussy', 'pussies', 'p*ssy',

  // N-word and variants
  'nigga', 'niggas', 'nigger', 'niggers', 'n*gga', 'n*gger',

  // H-word
  'hoe', 'hoes', 'ho',

  // W-word
  'whore', 'whores',

  // T-word
  'thot', 'thots',

  // Other profanity
  'bastard', 'bastards',
  'damn', 'dammit', 'goddamn', 'goddamned',
  'hell',
  'crap', 'crappy',
  'piss', 'pissed', 'pissing',
  'cock', 'cocks', 'c*ck',
  'slut', 'sluts',
  'retard', 'retarded',
  'fag', 'faggot', 'faggots',
  'skank',
  'twat',
  'wanker',
  'bollocks',
  'crackhead',
]

/**
 * Check if a single transcribed word is profane.
 * Strips punctuation and compares lowercase.
 */
export function isProfane(word: string): boolean {
  const cleaned = word.toLowerCase().replace(/[^a-z0-9*]/g, '')
  return PROFANITY_LIST.includes(cleaned)
}

/**
 * Return all unique profane words found in a lyrics line.
 * Splits by whitespace so each token is tested as a whole word —
 * "bass" will never match "ass", "classic" will never match "ass", etc.
 *
 * Also detects censored variants that appear in lyrics databases:
 * "f*ck", "motherf**ker", "n***a", etc. Converts asterisks to a wildcard
 * regex and tests against clean (non-starred) entries in the profanity list.
 */
export function extractProfaneWords(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const token of text.split(/\s+/)) {
    const cleaned = token.toLowerCase().replace(/[^a-z0-9*]/g, '')
    if (!cleaned) continue

    let matched: string | undefined

    // Direct match (handles plain words and starred list entries like "f*ck")
    if (PROFANITY_LIST.includes(cleaned)) {
      matched = cleaned
    } else if (cleaned.length >= 3 && cleaned.includes('*')) {
      // Censored-variant match: replace runs of * with [a-z]* and test
      // against the clean (no-asterisk) subset of the profanity list.
      // e.g. "motherf**ker" → /^motherf[a-z]*ker$/ → matches "motherfucker"
      const re = new RegExp('^' + cleaned.replace(/\*+/g, '[a-z]*') + '$')
      matched = PROFANITY_LIST.find((p) => !p.includes('*') && re.test(p))
    }

    if (matched && !seen.has(matched)) {
      seen.add(matched)
      result.push(matched)
    }
  }

  return result
}

/**
 * Word list for AssemblyAI keyterms_prompt — boosts detection accuracy
 * for words the model might otherwise mishear in music.
 */
export const WORD_BOOST: string[] = [
  'fuck', 'fucking', 'fuckin', 'shit', 'bitch', 'ass', 'asshole',
  'nigga', 'niggas', 'nigger', 'damn', 'cunt', 'dick', 'pussy',
  'bastard', 'motherfucker', 'motherfucking', 'bullshit', 'hoe',
  'whore', 'cock', 'slut', 'fag', 'faggot', 'jackass', 'dumbass',
  'retard', 'thot', 'bih',
]
