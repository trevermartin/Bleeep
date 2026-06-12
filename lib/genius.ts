/**
 * Genius lyrics helper.
 *
 * The official Genius API search endpoint returns metadata (including the song
 * page URL) but not the lyrics text itself. So we search for the best-matching
 * song, then fetch its public lyrics page and extract the lyric lines from the
 * `data-lyrics-container` blocks.
 *
 * Returns null on any failure — lyrics are an optional alignment aid, never a
 * hard dependency of the processing pipeline.
 */

interface GeniusHit {
  result: {
    id: number
    url: string
    title: string
    primary_artist: { name: string }
  }
}

/** Search Genius for the best song match and return its lyrics page URL. */
async function findSongUrl(artist: string, song: string, apiKey: string): Promise<string | null> {
  const q = `${artist} ${song}`.trim()
  const res = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    console.warn(`[genius] search failed: HTTP ${res.status}`)
    return null
  }
  const data = await res.json()
  const hits: GeniusHit[] = data?.response?.hits ?? []
  if (hits.length === 0) return null
  return hits[0].result.url ?? null
}

/** Decode the handful of HTML entities Genius emits in lyric text. */
function decodeEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

/** Scrape the lyric text out of a Genius song page. */
async function scrapeLyrics(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BleeepBot/1.0)' },
  })
  if (!res.ok) {
    console.warn(`[genius] page fetch failed: HTTP ${res.status}`)
    return null
  }
  const html = await res.text()

  // Lyrics live inside one or more <div data-lyrics-container="true">…</div>.
  const containers = html.match(
    /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g
  )
  if (!containers || containers.length === 0) return null

  const text = containers
    .map((block) => decodeEntities(block))
    .join('\n')
    // Drop section markers like [Chorus], [Verse 1]
    .replace(/^\[.*?\]$/gm, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')

  return text.trim() || null
}

/**
 * Fetch lyrics for a track from Genius. Returns the plain lyric text, or null
 * if the key is missing, no match is found, or scraping fails.
 */
export async function fetchGeniusLyrics(artist: string, song: string): Promise<string | null> {
  const apiKey = process.env.GENIUS_API_KEY
  if (!apiKey) {
    console.warn('[genius] GENIUS_API_KEY not set — skipping lyrics lookup')
    return null
  }
  try {
    const url = await findSongUrl(artist, song, apiKey)
    if (!url) {
      console.log(`[genius] no match for "${artist} - ${song}"`)
      return null
    }
    const lyrics = await scrapeLyrics(url)
    if (lyrics) {
      console.log(`[genius] fetched ${lyrics.length} chars of lyrics for "${artist} - ${song}"`)
    }
    return lyrics
  } catch (err) {
    console.warn('[genius] lyrics lookup failed:', err)
    return null
  }
}
