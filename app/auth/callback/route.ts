import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Only allow same-site relative redirect targets. Rejects absolute URLs,
 * protocol-relative ("//evil.com"), backslash tricks ("/\evil.com"), and
 * userinfo tricks ("@evil.com") that would otherwise turn `${origin}${next}`
 * into an off-site redirect. Falls back to /dashboard.
 */
function safeNext(next: string | null): string {
  if (!next) return '/dashboard'
  // Must be a single-slash-rooted path with no scheme/host component.
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return '/dashboard'
  }
  try {
    // Resolve against a dummy origin; the result must stay on that origin and
    // keep the same path (no host smuggled in).
    const resolved = new URL(next, 'https://x.invalid')
    if (resolved.origin !== 'https://x.invalid') return '/dashboard'
    return resolved.pathname + resolved.search
  } catch {
    return '/dashboard'
  }
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = safeNext(searchParams.get('next'))

  if (code) {
    const cookieStore = await cookies()

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          },
        },
      }
    )

    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`)
}
