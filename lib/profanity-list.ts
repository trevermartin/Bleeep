/**
 * Comprehensive profanity word list for detection.
 * All entries are lowercase. Comparison is case-insensitive.
 */
export const PROFANITY_LIST: string[] = [
  // F-word and variants
  'fuck', 'fucker', 'fuckers', 'fucking', 'fucked', 'fucks', 'motherfucker',
  'motherfucking', 'motherfuckers', 'mf', 'mfer', 'fuk', 'fuq', 'phuck',
  'f*ck', 'f**k', 'fck',

  // S-word and variants
  'shit', 'shits', 'shitting', 'shitted', 'shitty', 'bullshit', 'dipshit',
  'horseshit', 'sh*t', 'sh1t', 'sheit',

  // A-word and variants
  'ass', 'asshole', 'assholes', 'asses', 'jackass', 'jackasses', 'smartass',
  'badass', 'dumbass', 'lardass', 'fatass', 'a**', 'a**hole',

  // B-word and variants
  'bitch', 'bitches', 'bitching', 'bitchy', 'b*tch', 'biatch', 'byatch',

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
  'whore', 'whores', 'w*ore',

  // Other common profanity
  'bastard', 'bastards',
  'damn', 'dammit', 'goddamn', 'goddamned', 'god damn',
  'hell', // context-dependent but often flagged
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

  // Drug slang (often censored in clean versions)
  'bong', 'blunt', 'dope', 'crackhead',

  // Common censored spellings (asterisks replaced by letters in transcription)
  'eff', 'effing',
]

/**
 * Check if a transcribed word matches the profanity list.
 * Strips punctuation and compares lowercase.
 */
export function isProfane(word: string): boolean {
  const cleaned = word.toLowerCase().replace(/[^a-z0-9*]/g, '')
  return PROFANITY_LIST.includes(cleaned)
}

/**
 * Word boost list for AssemblyAI — helps it detect these words more accurately.
 */
export const WORD_BOOST: string[] = [
  'fuck', 'fucking', 'shit', 'bitch', 'ass', 'asshole', 'nigga', 'niggas',
  'nigger', 'damn', 'cunt', 'dick', 'pussy', 'bastard', 'motherfucker',
  'motherfucking', 'bullshit', 'hoe', 'whore', 'cock', 'slut', 'fag',
  'faggot', 'jackass', 'dumbass', 'retard',
]
