/**
 * Build a normalized fingerprint for a track so the same song matches across
 * users despite filename noise: case, punctuation, accents, extra whitespace.
 *
 * "Childish Gambino" + "Lithonia"   → "childish gambino::lithonia"
 * "CHILDISH GAMBINO " + "Lithonia!" → "childish gambino::lithonia"
 *
 * Moved verbatim from the Vercel app's lib/fingerprint.ts.
 */
export function trackFingerprint(artist: string, track: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  return `${norm(artist)}::${norm(track)}`
}
