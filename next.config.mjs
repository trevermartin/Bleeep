/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for fluent-ffmpeg and ffmpeg-static in API routes (Next.js 14 key)
  experimental: {
    serverComponentsExternalPackages: ['fluent-ffmpeg', 'ffmpeg-static'],
    // Explicitly bundle the ffmpeg binary into the serverless functions.
    // Next.js output-file-tracing only follows JS imports; native binaries
    // returned as path strings are invisible to it and get excluded.
    outputFileTracingIncludes: {
      '/api/process': ['./node_modules/ffmpeg-static/**/*'],
      '/api/reprocess': ['./node_modules/ffmpeg-static/**/*'],
      // yt-dlp binary + ffmpeg (yt-dlp calls ffmpeg via --ffmpeg-location)
      '/api/soundcloud': ['./bin/yt-dlp', './node_modules/ffmpeg-static/**/*'],
      '/api/soundcloud/search': ['./bin/yt-dlp', './node_modules/ffmpeg-static/**/*'],
    },
  },

  // Image optimization
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
      },
    ],
  },

  // Baseline security headers applied to every response.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Stop MIME sniffing.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Clickjacking protection (belt-and-suspenders with CSP frame-ancestors).
          { key: 'X-Frame-Options', value: 'DENY' },
          // Force HTTPS for two years incl. subdomains.
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          // Don't leak full URLs to third parties.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Drop powerful features the app never uses.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          // Conservative CSP. 'unsafe-inline'/'unsafe-eval' are required by
          // Next.js 14's runtime + Tailwind's injected styles; everything else
          // is locked to same-origin plus the Supabase + Stripe endpoints the
          // app actually talks to. frame-ancestors 'none' blocks embedding.
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https://*.supabase.co",
              "media-src 'self' blob: https://*.supabase.co",
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com",
              "frame-src https://js.stripe.com https://hooks.stripe.com",
              "font-src 'self' data:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ]
  },
};

export default nextConfig;
