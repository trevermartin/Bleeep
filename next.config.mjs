/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for fluent-ffmpeg and ffmpeg-static in API routes (Next.js 14 key)
  experimental: {
    serverComponentsExternalPackages: ['fluent-ffmpeg', 'ffmpeg-static'],
    // Explicitly bundle the ffmpeg binary into the serverless function.
    // Next.js output-file-tracing only follows JS imports; native binaries
    // returned as path strings are invisible to it and get excluded.
    outputFileTracingIncludes: {
      '/api/process': ['./node_modules/ffmpeg-static/**/*'],
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
};

export default nextConfig;
